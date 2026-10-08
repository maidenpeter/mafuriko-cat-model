// Reads the text of a PDF offer in the browser, with pdfjs-dist. Nothing leaves the machine.
//
// How to use it:
//   const text = await pdfToText(await file.arrayBuffer());
// It gives plain text, line by line as the page shows it, with a blank line between paragraphs and
// between pages. It throws an Error whose message is ready to show to the underwriter:
// PDF_NO_TEXT_MESSAGE for a scan, PDF_LOCKED_MESSAGE for a password, PDF_UNREADABLE_MESSAGE otherwise.
// The bytes passed in are copied first, so the caller's buffer stays usable afterwards.
//
// Importing this module touches nothing: pdfjs-dist is loaded, and its worker file is named, only
// inside pdfToText. So it is safe to import from a server component or a test.
//
// Which build: the "legacy" build of pdfjs-dist, in the browser and in node alike. The main build
// of version 6 calls language features that only the newest browsers have and that node 22 lacks;
// the legacy build carries its own fallbacks for them, so an older office browser still works.
// What differs by environment is the worker. In a browser the parsing runs in a web worker, whose
// file is named the same way RiskMap.tsx names the MapLibre worker. In node (Vitest) there is no
// web worker: workerSrc is left alone and pdfjs loads its worker code into the same thread.
//
// If the worker fails to load in the built app (the console says "Setting up fake worker failed"
// or shows a 404 for pdf.worker), try in this order:
//   1. Copy node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs into public/ and call
//      pdfToText(data, { workerSrc: "/pdf.worker.min.mjs" }).
//   2. Check the server sends that file as JavaScript (text/javascript); a module worker refuses
//      any other content type.
// Offers set in Chinese, Japanese or Korean fonts would also need pdfjs-dist/cmaps served and
// passed as cMapUrl; offers in English do not.

export const PDF_NO_TEXT_MESSAGE = "This PDF has no text in it. It may be a scan: please supply the document as text or Word.";
export const PDF_LOCKED_MESSAGE = "This PDF is locked with a password. Please supply a copy without one.";
export const PDF_UNREADABLE_MESSAGE = "This file could not be read as a PDF. Please check it opens, or supply the document as text or Word.";

/** One run of text as pdfjs reports it. transform[4] and transform[5] are the left edge and the baseline, in points. */
export type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
};

export type PdfToTextOptions = {
  /** Address of the pdfjs worker file, to use instead of the bundled one. Browser only. */
  workerSrc?: string;
};

/** Two runs on one line get a space between them when the gap is wider than this share of the text size. */
const SPACE_GAP = 0.15;
/** A run belongs to a new line when its baseline moves by more than this share of the text size. */
const LINE_SHIFT = 0.5;
/** A blank line goes in where the drop to the next line is this many times the page's usual drop. */
const PARAGRAPH_GAP = 1.4;
/** The usual drop is never taken as more than this many times the text size (double spacing). */
const MAX_LINE_STEP = 2;

type Line = { text: string; y: number; size: number };

/**
 * Rebuilds the lines of one page from its text runs, in the order pdfjs gives them.
 * Runs on one baseline are joined, with a space where there is a gap; a new line starts when the
 * baseline changes or a run is marked as the end of a line; a blank line marks a paragraph gap.
 */
export function textItemsToText(items: readonly PdfTextItem[]): string {
  const lines: Line[] = [];
  let open: Line | null = null;
  let endX = 0;
  let lastSize = 12;

  const close = (line: Line | null): null => {
    if (!line) return null;
    const text = line.text.replace(/[ \t]+/g, " ").trim();
    if (text) lines.push({ ...line, text });
    lastSize = line.size;
    return null;
  };

  for (const item of items) {
    if (item.str === "") {
      if (item.hasEOL) open = close(open);
      continue;
    }
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const size: number = item.height || Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || open?.size || lastSize;
    if (open && Math.abs(y - open.y) > LINE_SHIFT * Math.max(size, open.size)) open = close(open);
    if (!open) {
      open = { text: item.str, y, size };
    } else {
      const gap = x - endX;
      const apart = gap > SPACE_GAP * size || gap < -LINE_SHIFT * size;
      const spaced = /\s$/.test(open.text) || /^\s/.test(item.str);
      open.text += apart && !spaced ? ` ${item.str}` : item.str;
      open.size = Math.max(open.size, size);
    }
    endX = x + item.width;
    if (item.hasEOL) open = close(open);
  }
  close(open);

  // The usual drop from one line to the next on this page: the middle one, leaning low.
  const drops: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const drop = lines[i - 1].y - lines[i].y;
    if (drop > 0) drops.push(drop);
  }
  drops.sort((a, b) => a - b);
  const usual = drops.length ? drops[Math.floor((drops.length - 1) / 2)] : 0;

  const out: string[] = [];
  lines.forEach((line, i) => {
    if (i > 0) {
      const before = lines[i - 1];
      const size = Math.max(line.size, before.size);
      const drop = before.y - line.y;
      const step = Math.min(usual || size, MAX_LINE_STEP * size);
      // A clear gap below, or a jump back up the page (a second column), starts a new paragraph.
      if (drop > PARAGRAPH_GAP * step || drop < -LINE_SHIFT * size) out.push("");
    }
    out.push(line.text);
  });
  return out.join("\n");
}

/** Joins the text of the pages, a blank line between them. Pages with no text are left out. */
export function joinPages(pages: readonly string[]): string {
  return pages
    .map((page) => page.trim())
    .filter(Boolean)
    .join("\n\n");
}

const inBrowser = () => typeof window !== "undefined" && typeof Worker !== "undefined";

/** The plain text of a PDF, page by page. Throws an Error with a message for the underwriter when there is none. */
export async function pdfToText(data: ArrayBuffer | Uint8Array, options: PdfToTextOptions = {}): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (inBrowser()) {
    pdfjs.GlobalWorkerOptions.workerSrc =
      options.workerSrc ?? new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();
  }

  // pdfjs hands the bytes to its worker and empties the buffer it was given, so it gets a copy.
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  const loading = pdfjs.getDocument({ data: bytes, verbosity: pdfjs.VerbosityLevel.ERRORS });
  try {
    const doc = await loading.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const item of content.items) if ("str" in item) items.push(item);
      pages.push(textItemsToText(items));
      page.cleanup();
    }
    const text = joinPages(pages);
    if (!text) throw new Error(PDF_NO_TEXT_MESSAGE);
    return text;
  } catch (error) {
    if (error instanceof Error && error.message === PDF_NO_TEXT_MESSAGE) throw error;
    const name = error instanceof Error ? error.name : "";
    throw new Error(name === "PasswordException" ? PDF_LOCKED_MESSAGE : PDF_UNREADABLE_MESSAGE, { cause: error });
  } finally {
    await loading.destroy().catch(() => undefined);
  }
}
