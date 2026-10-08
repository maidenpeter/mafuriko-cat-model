import JSZip from "jszip";
import type { DocxToText, ReadOfferFile } from "./types";

/**
 * Reading an offer file in the browser. A Word file is a zip; the words are in
 * word/document.xml. Headers, footers and footnotes sit in other files and are not read:
 * a placement memo keeps what matters in the body.
 */

const NOT_WORD = "This file could not be opened as a Word document (.docx).";

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// One pass, so "&amp;lt;" comes out as "&lt;" and is not decoded twice.
const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body: string) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body] ?? whole;
    const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

// Every tag, or the text between two tags.
const XML_PIECE = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;

/**
 * The paragraphs of a document.xml, in order. Word splits a paragraph into runs wherever the
 * formatting or the spell checker draws a line, often in the middle of a word, so the runs of a
 * paragraph are joined with nothing between them.
 */
export function paragraphsOf(xml: string): string[] {
  const done: string[] = [];
  // A text box is a paragraph inside a paragraph, so the open ones are kept as a stack.
  const open: string[] = [];
  let inText = false;
  // Word stores a text box twice, once for old readers. The second copy is skipped.
  let fallbackDepth = 0;

  for (const piece of xml.matchAll(XML_PIECE)) {
    const [, closing, tag, , selfClosing, text] = piece;
    if (text !== undefined) {
      if (inText && fallbackDepth === 0 && open.length > 0) open[open.length - 1] += decodeEntities(text);
      continue;
    }
    if (tag === "mc:Fallback") {
      if (closing) fallbackDepth = Math.max(0, fallbackDepth - 1);
      else if (!selfClosing) fallbackDepth++;
      continue;
    }
    if (fallbackDepth > 0) continue;

    if (tag === "w:p") {
      if (selfClosing) done.push("");
      else if (closing) done.push(open.pop() ?? "");
      else open.push("");
    } else if (tag === "w:t") {
      // Only w:t is read: w:delText is text struck out under tracked changes, w:instrText is a field code.
      inText = !closing && !selfClosing;
    } else if (!closing && open.length > 0) {
      if (tag === "w:tab") open[open.length - 1] += "\t";
      else if (tag === "w:br" || tag === "w:cr") open[open.length - 1] += "\n";
      else if (tag === "w:noBreakHyphen") open[open.length - 1] += "-";
    }
  }
  // A paragraph left open by a damaged file still counts.
  while (open.length > 0) done.push(open.pop() ?? "");
  return done;
}

export const docxToText: DocxToText = async (data) => {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error(NOT_WORD);
  }
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error(`${NOT_WORD} It has no document text inside.`);
  const xml = (await entry.async("string")).replace(/^\ufeff/, "");
  return paragraphsOf(xml).join("\n");
};

export const readOfferFile: ReadOfferFile = async (file) => {
  const extension = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1].toLowerCase() ?? "";
  let text: string;
  let kind: "docx" | "txt";
  if (extension === "docx") {
    text = await docxToText(await file.arrayBuffer());
    kind = "docx";
  } else if (extension === "txt") {
    // Windows line endings and a leading byte order mark would otherwise end up inside quotes.
    text = (await file.text()).replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
    kind = "txt";
  } else if (extension === "doc") {
    throw new Error("This is an older Word file (.doc). Save it as .docx, or paste its text into the box.");
  } else {
    throw new Error("Only .docx and .txt files can be read. For anything else, paste the text into the box.");
  }
  if (!text.trim()) throw new Error(`${file.name} has no text in it.`);
  return { name: file.name, kind, text };
};
