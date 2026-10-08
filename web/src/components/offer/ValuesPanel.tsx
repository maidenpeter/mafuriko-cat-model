"use client";

import { Fragment, useId, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { offerCsv } from "@/lib/offer/csv";
import type { FocusField, OfferFocus } from "@/lib/offer/focus";
import { plural } from "@/lib/offer/shared";
import type { ValueRef } from "@/lib/offer/types";
import { download } from "@/lib/session";
import { countQuotes, DocumentQuotes, type DocumentQuote } from "../DocumentQuotes";
import { Button, Card, Segmented, StatusIcon } from "../ui";
import { Chevron } from "./parts";
import { ValueRow } from "./ValueRow";
import { groupOpenAtFirst, groupSummary, nameInLine, rightColumnFrom, type ValueCounts, type ValueGroup } from "./values";

/** Which values the list shows: all of them, the ones code could not check, or the ones the document does not state. */
type Filter = "all" | "check" | "missing";

/** What the rest of the step can ask of the list of values. */
export interface ValuesHandle {
  /** Puts the keyboard on a value's box and brings it into view, unfolding its group and lifting a filter that hides it. */
  goTo: (fieldId: string) => void;
  /** Shows only the values the document does not state, and puts the keyboard on the first. */
  showNotStated: () => void;
}

interface Props {
  /** The offer as the walkthrough worked it out. Every value, status and sentence comes from here. */
  f: OfferFocus;
  /** The same values group by group, and their count: see valueGroups and countValues. */
  groups: ValueGroup[];
  counts: ValueCounts;
  /** The file's name, for the CSV's source column. */
  documentName: string;
  /** Types over a value, or clears it with null. False when what was typed could not be read for that value. */
  onEdit: (ref: ValueRef, value: string | null) => boolean;
  /** Accepts a value code could not check, as it stands. */
  onConfirm: (ref: ValueRef) => void;
  ref?: Ref<ValuesHandle>;
}

/**
 * What was read from the document, for a person to check: one row per stated value, in the groups
 * of the field list, and the values the document does not state as one line of names per group.
 * The document itself opens beside the rows on a wide step, and above them on a narrow one, only
 * when it is asked for.
 *
 * How to use it:
 *   const list = useRef<ValuesHandle>(null);
 *   <ValuesPanel key={readNumber} ref={list} f={focus} groups={groups} counts={counts} documentName={name} onEdit={edit} onConfirm={confirm} />
 *   list.current?.goTo("row:0:tivKes");
 * Give it a new key for each document read: which groups are folded and which answers are open belong to one reading.
 */
export function ValuesPanel({ f, groups, counts, documentName, onEdit, onConfirm, ref }: Props) {
  const uid = useId();
  const [filter, setFilter] = useState<Filter>("all");
  /** Which groups are unfolded. Set once as the document is first shown, so a group never folds under the reader's hands. */
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(groups.map((g) => [g.key, groupOpenAtFirst(g)])));
  /** Where the groups are cut into two columns. Fixed for the same reason. */
  const [rightFrom] = useState(() => rightColumnFrom(groups));
  /** The values the document does not state whose name has been pressed: each is a box waiting for the broker's answer. */
  const [answering, setAnswering] = useState<string[]>([]);
  /** The value picked out: its sentence is written under its row and marked in the document. */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  // -------------------------------------------------------------------------------------------
  // Finding a row once the screen has caught up
  // -------------------------------------------------------------------------------------------

  /** Runs after the list has been redrawn, so a row that has only just appeared can be found. */
  const afterDraw = (run: (root: HTMLElement) => void) => {
    requestAnimationFrame(() => {
      if (list.current) run(list.current);
    });
  };
  const intoView = (el: HTMLElement) => el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  const rowOf = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`[data-field="${id}"]`);
  /** The keyboard on a value's box, or on the row itself where it has none. */
  const focusBox = (id: string, scroll: boolean) =>
    afterDraw((root) => {
      const row = rowOf(root, id);
      if (!row) return;
      (row.querySelector<HTMLElement>("input, select, textarea") ?? row).focus({ preventScroll: true });
      if (scroll) intoView(row);
    });
  /** The keyboard on a value's name in its group's "Not stated" line. */
  const focusName = (id: string) => afterDraw((root) => root.querySelector<HTMLElement>(`[data-missing="${id}"]`)?.focus());

  /** Makes sure a value is on screen: its group unfolded, and no filter hiding it. */
  const reveal = (id: string) => {
    const group = groups.find((g) => g.fields.some((x) => x.id === id));
    const field = group?.fields.find((x) => x.id === id);
    if (!group || !field) return;
    if ((filter === "check" && field.status !== "unverified") || (filter === "missing" && field.status !== "missing")) setFilter("all");
    if (field.status === "missing") setAnswering((a) => (a.includes(id) ? a : [...a, id]));
    setOpen((o) => ({ ...o, [group.key]: true }));
  };

  useImperativeHandle(ref, () => ({
    goTo: (id) => {
      reveal(id);
      focusBox(id, true);
    },
    showNotStated: () => {
      setFilter("missing");
      afterDraw((root) => {
        root.querySelector<HTMLElement>("[data-missing]")?.focus({ preventScroll: true });
        root.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      });
    },
  }));

  // -------------------------------------------------------------------------------------------
  // The document's marks
  // -------------------------------------------------------------------------------------------

  const { fields } = f;
  const several = f.extraction.rows.length > 1;
  // The sentences to mark in the document: one for each value that has one. A value the fixed rules read
  // and code found in its sentence is "Verified" here, as it is in its row.
  const quotes = useMemo<DocumentQuote[]>(
    () => fields.flatMap((x) => (x.mark && x.quote.trim() ? [{ id: x.id, quote: x.quote, label: x.row !== null && several ? `Building ${x.row + 1}, ${x.label}` : x.label, status: x.mark === "rules" ? ("verified" as const) : x.mark }] : [])),
    [fields, several],
  );
  const found = useMemo(() => countQuotes(f.document.text, quotes), [f.document.text, quotes]);

  // -------------------------------------------------------------------------------------------
  // What the underwriter does to a value
  // -------------------------------------------------------------------------------------------

  const edit = (x: FocusField, value: string | null): boolean => {
    // An emptied box takes its row away. When the keyboard was in that row, it goes to the value's name.
    const keyboardInRow = value === null && !!list.current && !!rowOf(list.current, x.id)?.contains(document.activeElement);
    if (!onEdit(x.ref, value)) return false;
    setAnswering((a) => a.filter((id) => id !== x.id));
    if (value === null && activeId === x.id) setActiveId(null);
    if (keyboardInRow) focusName(x.id);
    return true;
  };

  const toCheck = groups.flatMap((g) => g.stated.filter((x) => x.status === "unverified").map((x) => x.id));
  const confirm = (x: FocusField) => {
    onConfirm(x.ref);
    if (filter !== "check") return focusBox(x.id, false);
    // The row leaves the list of values to check: the keyboard goes to the one after it, and back to the whole list when none is left.
    const at = toCheck.indexOf(x.id);
    const next = toCheck[at + 1] ?? toCheck[at - 1];
    if (next) return focusBox(next, false);
    setFilter("all");
    focusBox(x.id, false);
  };

  const clear = (x: FocusField) => {
    if (!onEdit(x.ref, null)) return;
    if (activeId === x.id) setActiveId(null);
    focusName(x.id);
  };

  /** A sentence pressed in the document: its value is picked out and brought into view, whatever was hiding it. */
  const pickInDocument = (id: string) => {
    setActiveId(id);
    reveal(id);
    afterDraw((root) => {
      const row = rowOf(root, id);
      if (row) intoView(row);
    });
  };

  // -------------------------------------------------------------------------------------------
  // What is on screen under the filter
  // -------------------------------------------------------------------------------------------

  const shown = filter === "check" ? groups.filter((g) => g.toCheck > 0) : filter === "missing" ? groups.filter((g) => g.missing.length > 0) : groups;
  const rowsOf = (g: ValueGroup): FocusField[] =>
    filter === "check" ? g.stated.filter((x) => x.status === "unverified") : g.fields.filter((x) => (x.status === "missing" ? answering.includes(x.id) : filter === "all"));
  const namesOf = (g: ValueGroup): FocusField[] => (filter === "check" ? [] : g.missing.filter((x) => !answering.includes(x.id)));

  // Two columns of groups where the list is wide enough for both, in the whole list only: a filtered list is short.
  const cut = rightFrom ? shown.findIndex((g) => g.key === rightFrom) : -1;
  const twoColumns = filter === "all" && cut > 0;
  const columns = twoColumns ? [shown.slice(0, cut), shown.slice(cut)] : [shown];

  const group = (g: ValueGroup) => {
    const rows = rowsOf(g);
    const names = namesOf(g);
    // A group holding a value to check stays unfolded, and a filtered list has nothing to fold.
    const foldable = filter === "all" && g.toCheck === 0;
    const isOpen = !foldable || (open[g.key] ?? true);
    const bodyId = `${uid}-group-${groups.indexOf(g)}`;
    // The group's name, then its count at the right. Where the two do not fit on one line the count goes under the name.
    const head = (
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="min-w-0 text-sm font-semibold text-ink">{g.title}</span>
        <span className="ml-auto inline-flex min-w-0 items-center gap-1.5 text-xs font-normal text-ink-2">
          {g.toCheck > 0 && <StatusIcon status="warn" size={13} />}
          {filter === "missing" ? `${g.missing.length} not stated` : filter === "check" ? `${g.toCheck} to check` : groupSummary(g, !isOpen)}
        </span>
      </span>
    );
    return (
      <section key={g.key} aria-label={g.title}>
        <h4 className="border-b border-axis">
          {foldable ? (
            <button type="button" aria-expanded={isOpen} aria-controls={bodyId} onClick={() => setOpen((o) => ({ ...o, [g.key]: !isOpen }))} className="flex w-full items-center gap-3 rounded-t-lg py-1.5 pl-3 pr-1 text-left hover:bg-surface-2">
              {head}
              <Chevron open={isOpen} />
            </button>
          ) : (
            <span className="flex items-center gap-3 py-1.5 pl-3 pr-1">
              {head}
              {/* The room a fold mark takes, so the counts of every heading end on one line. */}
              <span aria-hidden className="w-4 shrink-0" />
            </span>
          )}
        </h4>
        <div id={bodyId} hidden={!isOpen}>
          {isOpen && rows.length > 0 && (
            <ul className="divide-y divide-line">
              {rows.map((x) => (
                <ValueRow
                  key={x.id}
                  field={x}
                  active={x.id === activeId}
                  answering={x.status === "missing"}
                  onSentence={() => setActiveId(x.id === activeId ? null : x.id)}
                  onEdit={(value) => edit(x, value)}
                  onConfirm={() => confirm(x)}
                  onClear={() => clear(x)}
                  onAbandon={(byKey) => {
                    setAnswering((a) => a.filter((id) => id !== x.id));
                    if (byKey) focusName(x.id);
                  }}
                />
              ))}
            </ul>
          )}
          {isOpen && names.length > 0 && (
            <p className={`py-2 pl-3 pr-1 text-sm leading-relaxed text-muted ${rows.length > 0 ? "border-t border-line" : ""}`}>
              Not stated:{" "}
              {names.map((x, i) => (
                <Fragment key={x.id}>
                  {i > 0 && ", "}
                  <button
                    type="button"
                    data-missing={x.id}
                    title="Type the broker's answer"
                    onClick={() => {
                      setAnswering((a) => (a.includes(x.id) ? a : [...a, x.id]));
                      focusBox(x.id, false);
                    }}
                    className="text-ink-2 underline decoration-axis decoration-dotted underline-offset-4 hover:text-ink hover:decoration-ink-2"
                  >
                    {nameInLine(x)}
                    <span className="sr-only">: type the answer</span>
                  </button>
                </Fragment>
              ))}
            </p>
          )}
        </div>
      </section>
    );
  };

  return (
    <Card
      title="What was read"
      className="mt-4"
      aside={
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
          <span className="min-w-0 text-xs leading-relaxed text-muted">
            {found.asked === 0 ? "No sentence to mark in the document" : `${found.found} of ${plural(found.asked, "sentence")} found in the document`}; contact details removed
          </span>
          <Button variant="secondary" className="whitespace-nowrap" aria-expanded={docOpen} aria-controls={`${uid}-document`} onClick={() => setDocOpen(!docOpen)}>
            <svg viewBox="0 0 20 20" aria-hidden className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 2.5h6.5L15 6v11.5H5zM11.5 2.5V6H15M7.5 10h5M7.5 13.5h5" />
            </svg>
            {docOpen ? "Hide the document" : "View the document"}
          </Button>
        </span>
      }
    >
      {/* The values keep their place in this grid whether the document is open or not, so nothing typed is lost when it opens or closes. */}
      <div className={`grid items-start gap-x-6 gap-y-5 ${docOpen ? "@5xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]" : ""}`}>
        {/* Above the values on a narrow step. Beside them on a wide one, where it stays in view, just below the header, while they scroll. */}
        <div id={`${uid}-document`} hidden={!docOpen} className="min-w-0 @5xl:sticky @5xl:top-[calc(var(--header-height,9rem)+1rem)] @5xl:order-last @5xl:self-start">
          {docOpen && (
            <>
              <DocumentQuotes
                text={f.document.text}
                quotes={quotes}
                activeId={activeId}
                onSelect={pickInDocument}
                showCount={false}
                focusActive={false}
                panelClassName="max-h-[24rem] @5xl:max-h-[max(14rem,calc(100dvh-var(--header-height,9rem)-13rem))]"
              />
              <p className="mt-2 text-xs leading-relaxed text-muted">Press a marked sentence to find its value.</p>
            </>
          )}
        </div>

        <div ref={list} className="min-w-0 scroll-mt-[calc(var(--header-height,9rem)+1rem)]">
          <div className="mb-4">
            <Segmented<Filter>
              label="Which values to show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "check", label: `To check (${counts.toCheck})` },
                { value: "missing", label: `Not stated (${counts.notStated})` },
              ]}
            />
          </div>

          {f.extraction.rows.length === 0 && filter === "all" && <p className="mb-4 text-sm leading-relaxed text-ink-2">No insured building was read from the document.</p>}
          {shown.length === 0 && (
            <p className="text-sm leading-relaxed text-ink-2">
              {filter === "check" ? "Nothing to check: every value read is verified, confirmed or typed by you." : "The document states every value."}
            </p>
          )}

          {/* Measured twice: the list decides between one column of groups and two, and each column decides how its rows are laid out. */}
          <div className="@container">
            <div className={twoColumns ? "grid gap-x-10 gap-y-5 @7xl:grid-cols-2" : "max-w-[56rem]"}>
              {columns.map((column, i) => (
                <div key={i} className="@container min-w-0 space-y-5">
                  {column.map(group)}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3">
            <Button
              variant="secondary"
              className="whitespace-nowrap"
              disabled={f.rows.length === 0}
              onClick={() => download(`offer-rows-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`, offerCsv(f.rows, documentName), "text/csv")}
            >
              Download the rows as CSV
            </Button>
            <span className="min-w-0 flex-1 basis-56 text-xs leading-relaxed text-muted">
              {plural(f.rows.length, "row")} in the exposure file&apos;s columns. A value that is not known, or not yet confirmed, is left blank.
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}
