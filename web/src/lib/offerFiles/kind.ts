// Which kind of file an underwriter has picked as the broker's offer. Pure: no browser, no reading of the file.
//
// How to use it:
//   <input type="file" accept={ACCEPT} />
//   const kind = offerFileKind(file.name, file.type);
//   const problem = offerFileProblem(kind);      // a sentence to show, or null when the file can be read
//   if (problem) show it and stop;
//   "docx" goes to the Word reader, "pdf" to pdfToText (./pdf), "txt" is read as plain text.
//
// The extension decides first, whatever its case. The mime type is only asked when the name has no
// extension this app knows, because browsers often leave the type empty or report a wrong one.

export type OfferFileKind = "docx" | "pdf" | "txt" | "doc" | "unknown";

/** Shown for a Word 97 to 2003 file, which this app does not read. */
export const OLD_WORD_MESSAGE = "Old Word format, please save as .docx";

/** Shown for any file that is not Word, PDF or plain text. */
export const UNKNOWN_KIND_MESSAGE = "This file type cannot be read. Please supply a .docx, .pdf or .txt file.";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** For the accept attribute of a file input: the three kinds this app reads, by extension and by mime type. */
export const ACCEPT = `.docx,.pdf,.txt,${DOCX_MIME},application/pdf,text/plain`;

const BY_EXTENSION: Record<string, OfferFileKind> = { docx: "docx", pdf: "pdf", txt: "txt", doc: "doc" };

const BY_MIME: Record<string, OfferFileKind> = {
  [DOCX_MIME]: "docx",
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "text/plain": "txt",
  "application/msword": "doc",
};

/** offer.DOCX → "docx", "Slip 2026.pdf" → "pdf", notes.txt → "txt", old.doc → "doc", photo.png → "unknown". */
export function offerFileKind(name: string, mimeType?: string | null): OfferFileKind {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf(".");
  const extension = dot >= 0 ? trimmed.slice(dot + 1).toLowerCase() : "";
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  // Object.hasOwn keeps a name such as "offer.constructor" from matching something built in.
  if (Object.hasOwn(BY_EXTENSION, extension)) return BY_EXTENSION[extension];
  if (Object.hasOwn(BY_MIME, mime)) return BY_MIME[mime];
  return "unknown";
}

/** The sentence to show when a file of this kind cannot be read, or null when it can. */
export function offerFileProblem(kind: OfferFileKind): string | null {
  if (kind === "doc") return OLD_WORD_MESSAGE;
  if (kind === "unknown") return UNKNOWN_KIND_MESSAGE;
  return null;
}
