import { plural } from "./shared";
import type { DescribeRemoved, Redact, RemovedBlock } from "./types";

/**
 * What is taken out of an offer before any of it leaves the browser: email addresses, phone
 * numbers, and the blocks that say who to contact and who signed.
 *
 * Everything else is kept word for word, because code later checks that every quoted sentence
 * is in this text. So the rules lean towards keeping: a line is removed only when it sits in a
 * block that is plainly about people, and a line with figures in it is left alone.
 *
 * Names written inside ordinary sentences are not removed. Only code that understood the
 * language could find them, and this is fixed rules.
 */

const EMAIL_MARK = "[email removed]";
const PHONE_MARK = "[phone removed]";
const CONTACT_MARK = "[contact details removed]";
const SIGNATURE_MARK = "[signature block removed]";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

// "+254 (20) 555-0123", "+254 712 345 678", "+254712345678". No dots and no commas between
// the groups, so a decimal or an amount with separators can never match.
const PHONE_INTERNATIONAL = /\+\d{1,3}(?:[ \u00a0-]?\(?\d{1,4}\)?){2,5}/g;
// "0712 345 678", "0712-345678", "020 123 4567", "(020) 123 4567". The first digit after the
// zero is not a zero, so the "000 000 000" of an amount written with spaces is not a phone.
const PHONE_LOCAL = /(^|[^\d.,+-])((?:\(0[1-9]\d{0,2}\)|0[1-9]\d{0,2})[ \u00a0-]?\d{3}[ \u00a0-]?\d{3,4})(?!\d)/g;

const digitCount = (text: string) => text.replace(/\D/g, "").length;

/** One line with its email addresses and phone numbers replaced by markers. */
function stripDetails(line: string, count: { emails: number; phones: number }): string {
  let out = line.replace(EMAIL, () => {
    count.emails++;
    return EMAIL_MARK;
  });
  out = out.replace(PHONE_INTERNATIONAL, (found) => {
    const digits = digitCount(found);
    if (digits < 9 || digits > 15) return found;
    count.phones++;
    return PHONE_MARK;
  });
  out = out.replace(PHONE_LOCAL, (found, before: string, number: string, at: number) => {
    // "2 050 000 000" is an amount: a group of digits and a space come just before.
    if (/\d[ \u00a0]$/.test(out.slice(Math.max(0, at - 2), at + before.length))) return found;
    count.phones++;
    return before + PHONE_MARK;
  });
  return out;
}

// --- Blocks -------------------------------------------------------------------------------------

// "PRINCIPAL CONTACT:", "Prepared/certified by: A. Person". Short, and words only before the colon.
const LABEL = /^\s*([A-Za-z][A-Za-z /&'.()-]{1,40}):\s*(.*)$/;

// Who signed or drew up the document.
const SIGNATURE_LABEL = /\b(?:signature|signed|signatory)\b|\b(?:certified|prepared|authori[sz]ed|approved|reviewed|submitted|compiled) by\b|^for and on behalf\b/i;
// Who to get in touch with. The label must end on the word, so "AREAS REQUIRING ATTENTION" is not one.
const CONTACT_LABEL = /\bcontacts?(?: details| person| information)?$|^(?:for the )?attention(?: of)?$|^attn\.?$/i;
// A named person's job. Again the label must end on the word: "FACILITY MANAGER", not "RISK MANAGEMENT".
const ROLE_LABEL = /\b(?:advisor|adviser|manager|officer|director|executive|secretary|representative|handler)$/i;
// Labels that belong inside a contact or signature block.
const DETAIL_LABEL = /^(?:tel|telephone|phone|mobile|cell|fax|e-?mail|direct(?: line)?|office|whatsapp|website|web|address|postal address|contact|date|dated|name|title|position|designation|company|organi[sz]ation|firm)\.?$/i;

const SIGNATURE_LINE = /_{4,}/;
const HAS_DETAIL = /\[(?:email|phone) removed\]/;
const WHOLE_LINE_MARK = /^\s*\[(?:contact details|signature block) removed\]\s*$/;
const POSTAL_LINE = /\bP\.? ?O\.? ?Box\b/i;

// "A few short lines": beyond these a block is taken to be something else.
const MAX_BLOCK_LINES = 8;
const MAX_LINE_CHARS = 80;

function labelOf(line: string): { label: string; value: string } | null {
  const match = LABEL.exec(line);
  if (!match) return null;
  const label = match[1].trim();
  if (label.split(/\s+/).length > 5) return null;
  return { label, value: match[2].trim() };
}

/** A sentence, not a name or an address: it ends like one, or it is simply long. */
function isProse(line: string): boolean {
  const words = line.trim().split(/\s+/).length;
  return words >= 9 || (words >= 5 && /[.!?]$/.test(line.trim()));
}

/**
 * How many lines after `start` belong to the block that begins there. Stops at a blank line,
 * at a line that reads as a sentence, at a label that is not about a person, and, in a contact
 * block, at any line with figures in it.
 */
function linesAfter(lines: string[], start: number, kind: "contact" | "signature"): number {
  let n = 0;
  while (n < MAX_BLOCK_LINES) {
    const line = lines[start + 1 + n];
    if (line === undefined || !line.trim()) break;
    if (line.length > MAX_LINE_CHARS || WHOLE_LINE_MARK.test(line) || SIGNATURE_LINE.test(line)) break;
    const labelled = labelOf(line);
    if (labelled) {
      if (!DETAIL_LABEL.test(labelled.label) && !HAS_DETAIL.test(line)) break;
    } else if (!HAS_DETAIL.test(line)) {
      if (isProse(line)) break;
      // A date under a signature goes with it. In a contact block a figure could be a value.
      if (kind === "contact" && /\d/.test(line) && !POSTAL_LINE.test(line)) break;
    }
    n++;
  }
  return n;
}

interface Block {
  kind: "contact" | "signature";
  name: string;
  /** Lines taken, counting the first. */
  lines: number;
}

/** The contact or signature block that begins on this line, if one does. */
function blockAt(lines: string[], i: number): Block | null {
  const line = lines[i];
  if (!line.trim() || WHOLE_LINE_MARK.test(line)) return null;
  const labelled = labelOf(line);

  // A row of underscores is a place to sign, whatever is written beside it.
  if (SIGNATURE_LINE.test(line)) {
    const name = labelled && SIGNATURE_LABEL.test(labelled.label) ? labelled.label : "signature";
    return { kind: "signature", name, lines: 1 + linesAfter(lines, i, "signature") };
  }
  if (!labelled) return null;
  const { label, value } = labelled;

  const kind = SIGNATURE_LABEL.test(label) ? "signature" : CONTACT_LABEL.test(label) || ROLE_LABEL.test(label) ? "contact" : null;
  if (kind) {
    // A long value is a sentence that happens to follow a colon, and a job title followed
    // by figures is more likely a finding than a name.
    if (value.length > MAX_LINE_CHARS) return null;
    if (value && ROLE_LABEL.test(label) && !HAS_DETAIL.test(value) && /\d/.test(value)) return null;
    const after = linesAfter(lines, i, kind);
    // A heading with nothing under it holds no details.
    if (!value && after === 0) return null;
    return { kind, name: label, lines: 1 + after };
  }

  // Any other heading with nothing beside it, when the lines under it are all contact
  // details down to the next blank line and an email or a phone number is among them.
  if (!value) {
    const after = linesAfter(lines, i, "contact");
    const next = lines[i + 1 + after];
    const wholeGroup = next === undefined || !next.trim();
    if (after > 0 && wholeGroup && lines.slice(i + 1, i + 1 + after).some((l) => HAS_DETAIL.test(l))) return { kind: "contact", name: label, lines: 1 + after };
  }
  return null;
}

export const redact: Redact = (text) => {
  const count = { emails: 0, phones: 0 };
  const blocks: RemovedBlock[] = [];
  // Details first, so the block rules see the same lines on a second run as on the first.
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => stripDetails(line, count));
  const kept: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const block = blockAt(lines, i);
    if (block) {
      kept.push(block.kind === "contact" ? CONTACT_MARK : SIGNATURE_MARK);
      blocks.push({ name: block.name, lines: block.lines });
      i += block.lines;
    } else {
      kept.push(lines[i]);
      i++;
    }
  }
  return { text: kept.join("\n"), removed: { emails: count.emails, phones: count.phones, blocks } };
};

/** One plain sentence on what was taken out, for the panel that shows the text sent. */
export const describeRemoved: DescribeRemoved = (removed, sent = true) => {
  const parts: string[] = [];
  if (removed.emails > 0) parts.push(plural(removed.emails, "email address", "email addresses"));
  if (removed.phones > 0) parts.push(plural(removed.phones, "phone number"));
  if (removed.blocks.length > 0) parts.push(`${plural(removed.blocks.length, "contact or signature block")} (${removed.blocks.map((b) => b.name).join(", ")})`);
  if (parts.length === 0) return "Nothing was removed: no email addresses, phone numbers, contact blocks or signature blocks were found.";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Removed ${sent ? "before sending" : "before reading"}: ${list}.`;
};
