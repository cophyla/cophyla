// Codex's `request_user_input` dialog as its TUI keeps it (0.162.1, tui/src/bottom_pane/
// request_user_input/mod.rs), for typing into without a TUI: one question shown at a time,
// options with a "None of the above" row after them, the pointer starting on the first option,
// digits choosing and moving on, Tab and Esc opening and clearing notes, Enter committing,
// PageUp/PageDown and Left/Right moving between questions, Esc with the notes shut
// interrupting the turn, and the confirmation when the last is submitted with any unanswered.
// Its screen is the rows the overlay draws, under a transcript whose rows look like its own.
// `pasteAsKeys` delivers a paste as keystrokes, as a console without bracketed paste does.

export interface FakeQuestion {
  id: string;
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
}

interface Answer {
  selected?: number;
  committed: boolean;
  notesVisible: boolean;
  draft: string;
}

export class FakeCodexDialog {
  readonly questions: FakeQuestion[];
  idx = 0;
  focus: "options" | "notes" = "options";
  answers: Answer[];
  /** The confirmation's pointer, while it is up. */
  confirm?: number;
  done = false;
  interrupted = false;
  submitted?: Record<string, { answers: string[] }>;
  readonly keysLog: string[] = [];
  readonly pastes: string[] = [];
  pasteAsKeys = false;
  /** The next Enter after a paste goes into the notes as a line break, as one inside a paste burst does. */
  swallowEnterAfterPaste = false;
  private swallowNext = false;
  /** Rows above the dialog. */
  transcript = ["› an earlier prompt of the user's", "", "• 1. a numbered line the agent wrote", "  2. and another", ""];

  constructor(questions: FakeQuestion[]) {
    this.questions = questions;
    this.answers = questions.map(() => ({ selected: 0, committed: false, notesVisible: false, draft: "" }));
  }

  private get cur(): Answer {
    return this.answers[this.idx]!;
  }

  private optionsLen(i = this.idx): number {
    return this.questions[i]!.options.length + 1;
  }

  private notesShown(i = this.idx): boolean {
    const a = this.answers[i]!;
    return a.notesVisible || a.draft.trim() !== "";
  }

  private ensureFocus(): void {
    if (this.focus === "notes" && !this.notesShown()) this.focus = "options";
  }

  private move(next: boolean): void {
    const n = this.questions.length;
    this.idx = (this.idx + (next ? 1 : n - 1)) % n;
    this.ensureFocus();
  }

  private unanswered(): number {
    return this.answers.filter((a) => !(a.selected !== undefined && a.committed)).length;
  }

  private goNextOrSubmit(): void {
    if (this.idx + 1 >= this.questions.length) {
      if (this.unanswered() > 0) this.confirm = 0;
      else this.submit();
    } else this.move(true);
  }

  private submit(): void {
    const out: Record<string, { answers: string[] }> = {};
    this.questions.forEach((q, i) => {
      const a = this.answers[i]!;
      const list: string[] = [];
      if (a.committed && a.selected !== undefined) list.push(a.selected < q.options.length ? q.options[a.selected]!.label : "None of the above");
      const notes = a.committed ? a.draft.trim() : "";
      if (notes) list.push(`user_note: ${notes}`);
      out[q.id] = { answers: list };
    });
    this.submitted = out;
    this.confirm = undefined;
    this.done = true;
  }

  private clearNotes(): void {
    Object.assign(this.cur, { draft: "", committed: false, notesVisible: false });
    this.focus = "options";
  }

  keys(keys: string[]): void {
    for (const k of keys) {
      this.keysLog.push(k);
      if (this.done) continue;
      this.key(k);
    }
  }

  private key(k: string): void {
    if (this.confirm !== undefined) {
      if (k === "Escape" || k === "Backspace") {
        this.confirm = undefined;
        const first = this.answers.findIndex((a) => !(a.selected !== undefined && a.committed));
        if (first >= 0) this.idx = first;
      } else if (k === "Up" || k === "Down") this.confirm = 1 - this.confirm;
      else if (k === "1" || k === "2") this.confirm = Number(k) - 1;
      else if (k === "Enter") {
        if (this.confirm === 0) this.submit();
        else {
          this.confirm = undefined;
          const first = this.answers.findIndex((a) => !(a.selected !== undefined && a.committed));
          if (first >= 0) this.idx = first;
        }
      }
      return;
    }
    if (k === "Escape") {
      if (this.notesShown()) this.clearNotes();
      else {
        this.interrupted = true;
        this.done = true;
      }
      return;
    }
    if (k === "PageUp") return this.move(false);
    if (k === "PageDown") return this.move(true);
    if (this.focus === "options") {
      if (k === "Left" || k === "h") return this.move(false);
      if (k === "Right" || k === "l") return this.move(true);
      const len = this.optionsLen();
      if (k === "Up" || k === "k") {
        this.cur.selected = ((this.cur.selected ?? 0) + len - 1) % len;
        this.cur.committed = false;
      } else if (k === "Down" || k === "j") {
        this.cur.selected = ((this.cur.selected ?? -1) + 1) % len;
        this.cur.committed = false;
      } else if (k === " ") this.cur.committed = true;
      else if (k === "Tab" && this.cur.selected !== undefined) {
        this.focus = "notes";
        this.cur.notesVisible = true;
      } else if (k === "Enter") {
        if (this.cur.selected === len - 1) {
          this.focus = "notes";
          this.cur.notesVisible = true;
          return;
        }
        if (this.cur.selected !== undefined) this.cur.committed = true;
        this.goNextOrSubmit();
      } else if (/^\d$/.test(k)) {
        const i = Number(k) - 1;
        if (i < 0 || i >= len) return;
        this.cur.selected = i;
        this.cur.committed = true;
        this.goNextOrSubmit();
      }
      return;
    }
    // notes
    if (k === "Tab") return this.clearNotes();
    if (k === "Backspace" && this.cur.draft.trim() === "") {
      this.cur.notesVisible = false;
      this.focus = "options";
      return;
    }
    if (k === "Up" || k === "Down") return;
    if (k === "Enter") {
      if (this.swallowNext) {
        this.swallowNext = false;
        this.cur.draft += "\n";
        this.cur.committed = false;
        return;
      }
      this.cur.notesVisible = true;
      this.cur.committed = true;
      this.goNextOrSubmit();
      return;
    }
    if (k === "Backspace") this.cur.draft = this.cur.draft.slice(0, -1);
    else if (k.length === 1) this.cur.draft += k;
    this.cur.committed = false;
  }

  paste(text: string): void {
    this.pastes.push(text);
    if (this.done) return;
    if (this.pasteAsKeys) {
      this.keys([...text].map((c) => (c === "\r" || c === "\n" ? "Enter" : c)));
    } else {
      if (this.focus === "options") this.focus = "notes";
      this.cur.notesVisible = true;
      this.cur.committed = false;
      this.cur.draft += text;
    }
    if (this.swallowEnterAfterPaste) this.swallowNext = true;
  }

  /** The screen: the transcript, then the dialog (or its confirmation, or the composer once it is done). */
  screen(): { lines: string[] } {
    const rows = [...this.transcript];
    if (this.done) return { lines: [...rows, "› ", "", "  ? for shortcuts"] };
    if (this.confirm !== undefined) {
      const u = this.unanswered();
      rows.push("  Submit with unanswered questions?", `  ${u} unanswered question${u === 1 ? "" : "s"}`, "", `  ${this.confirm === 0 ? "›" : " "} 1. Proceed  Submit with ${u} unanswered`, `  ${this.confirm === 1 ? "›" : " "} 2. Go back  Return to the first unanswered question`);
      return { lines: rows };
    }
    const q = this.questions[this.idx]!;
    const u = this.unanswered();
    rows.push(`  Question ${this.idx + 1}/${this.questions.length}${u > 0 ? ` (${u} unanswered)` : ""}`);
    // the question wrapped at 30 columns
    for (const line of q.question.match(/.{1,30}(\s|$)/g) ?? [q.question]) rows.push(`  ${line.trim()}`);
    rows.push("");
    const labels = [...q.options.map((o) => [o.label, o.description ?? ""]), ["None of the above", "Optionally, add details in notes (tab)"]];
    labels.forEach(([label, description], i) => rows.push(`  ${this.cur.selected === i ? "›" : " "} ${i + 1}. ${label}  ${description}`));
    if (this.notesShown()) rows.push("", `  ${this.cur.draft || "Add notes"}`);
    rows.push("");
    const tips: string[] = [];
    if (this.cur.selected !== undefined && !this.notesShown()) tips.push("tab to add notes");
    if (this.cur.selected !== undefined && this.notesShown()) tips.push("tab or esc to clear notes");
    tips.push(this.idx + 1 >= this.questions.length ? "enter to submit all" : "enter to submit answer");
    if (this.questions.length > 1 && this.focus === "options") tips.push("←/→ to navigate questions");
    if (!this.notesShown()) tips.push("esc to interrupt");
    rows.push(`  ${tips.join(" | ")}`);
    return { lines: rows };
  }
}
