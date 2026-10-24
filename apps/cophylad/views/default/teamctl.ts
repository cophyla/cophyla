// Group chats, focus and teammates on the host's line: what the view asks for as it connects
// (`group.list`, `focus.list`, `teammate.list`), the notices it folds in (`group.state`,
// `group.posted`, `focus.state`, `teammate.state`), and what the user's clicks, forms and keys
// in teamview.ts's parts ask of the node. A group's posts are asked for as its tab opens, a
// page back at a time, and what the user read is told once the end of them is in view. A node
// or an app older than these refuses them (`unsupported`): the lists are then quietly empty,
// and a request the user made says to update.

import type { Focus, FolderPick, Group, GroupCandidate, GroupNotify, GroupPost, Teammate, TeammatePlace, ClientWorkspace as Workspace } from "@cophyla/protocol";
import { broadShares, buildShare, candidateKey, closedPlaces, completeTag, enterSends, excludePlace, groupCreateParams, openPlace, readUpTo, tagCompletion, teamworkFailure } from "./model.ts";
import type { Action, ViewState } from "./model.ts";
import { fitField } from "./render.ts";
import type { Roots, UiState } from "./render.ts";
import type { HostRpc } from "./rpc.ts";
import { ViewRpcError } from "./rpc.ts";
import { MediaControl } from "./groupmedia.ts";
import { folderKey, groupStream } from "./teamview.ts";
import type { AgentPick, NewGroupForm, ShareForm } from "./teamview.ts";

export interface TeamDeps {
  rpc: HostRpc;
  state: ViewState;
  ui: UiState;
  roots: Roots;
  dispatch: (action: Action, opts?: { anchor?: boolean }) => void;
  draw: () => void;
  /** Shows a group's tab, or the chat's with none. */
  selectGroup: (id: string | undefined) => void;
  /** On a phone, the rail goes from over the pane once what it shows is picked. */
  putRailAway: () => void;
  /** On a phone's width no field takes the focus by itself, which would bring the keyboard up. */
  phone: () => boolean;
}

export class TeamControl {
  private d: TeamDeps;
  /** The user's own post just went: the group's posts scroll to their end once drawn. */
  private toEnd = false;
  /** Lists refused as kept by the primary: asked again once the node may be it. */
  private refused = new Set<"groups" | "focus" | "teammates">();

  /** The composer's photos and files, and the posts'. */
  readonly media: MediaControl;

  constructor(deps: TeamDeps) {
    this.d = deps;
    this.media = new MediaControl({ rpc: deps.rpc, state: deps.state, media: deps.ui.team.media, draw: () => deps.draw(), dispatch: (a) => deps.dispatch(a), words: (e) => this.words(e) });
  }

  /** Whether the group shown takes photos and files now: its composer may post. */
  mayAttach(): string | undefined {
    const { state, ui } = this.d;
    const g = ui.group !== undefined ? state.groups.get(ui.group) : undefined;
    if (!g || g.ended || !state.connected || !state.scopes.includes("sessions:write")) return undefined;
    return g.id;
  }

  // --- the line ------------------------------------------------------------------------------------

  /** The line is up: the groups, the focus and the teammates, asked for afresh. */
  connected(): void {
    void this.loadGroups();
    void this.loadFocus();
    void this.loadTeammates();
  }

  /** The line went: what was told as read is told again, and the tags offered go. */
  disconnected(): void {
    this.d.ui.team.readSent.clear();
    this.d.ui.team.complete = undefined;
  }

  async loadGroups(): Promise<void> {
    if (!this.d.state.scopes.includes("sessions:read")) return;
    try {
      const { groups } = await this.d.rpc.request<{ groups: Group[] }>("group.list", {});
      this.refused.delete("groups");
      this.d.dispatch({ type: "groups", groups });
      // the group shown has its posts asked for again: the line dropped since they came
      const shown = this.d.ui.group;
      if (shown !== undefined && this.d.state.groups.has(shown)) void this.loadPosts(shown);
    } catch (e) {
      this.quiet("groups", "group chats", e);
    }
  }

  async loadFocus(): Promise<void> {
    if (!this.d.state.scopes.includes("sessions:read")) return;
    try {
      const { focus } = await this.d.rpc.request<{ focus: { session: string; focus: Focus }[] }>("focus.list", {});
      this.refused.delete("focus");
      this.d.dispatch({ type: "focus", focus });
    } catch (e) {
      this.quiet("focus", "focus", e);
    }
  }

  async loadTeammates(): Promise<void> {
    if (!this.d.state.scopes.includes("controllers")) return;
    try {
      const { teammates } = await this.d.rpc.request<{ teammates: Teammate[] }>("teammate.list", {});
      this.refused.delete("teammates");
      this.d.dispatch({ type: "teammates", teammates });
    } catch (e) {
      this.quiet("teammates", "teammates", e);
    }
  }

  /** A notice for these parts, folded in; false for any other. */
  notification(method: string, params: unknown): boolean {
    switch (method) {
      case "group.state": {
        const g = params as Group & { left?: boolean };
        this.d.dispatch({ type: "group.state", params: g });
        if (g.left) this.forget(g.id);
        return true;
      }
      case "group.posted":
        this.d.dispatch({ type: "group.posted", params: params as { group: string; post: GroupPost } });
        return true;
      case "focus.state":
        this.d.dispatch({ type: "focus.state", params: params as { session: string; focus?: Focus } });
        return true;
      case "teammate.state":
        this.d.dispatch({ type: "teammate.state", params: params as Teammate });
        return true;
      default:
        return false;
    }
  }

  /** What a refusal says, in words the user can act on. */
  private words(e: unknown): string {
    return teamworkFailure(e instanceof ViewRpcError ? e.code : undefined, e instanceof Error ? e.message : String(e));
  }

  private fail(what: string, e: unknown): void {
    this.d.dispatch({ type: "error", message: `${what}: ${this.words(e)}` });
  }

  /** A list a node or an app too old for it refuses, or one whose part is off there: none, said nowhere. */
  private quiet(part: "groups" | "focus" | "teammates", what: string, e: unknown): void {
    if (e instanceof ViewRpcError && (e.code === "unsupported" || e.code === "unavailable")) {
      if (e.code === "unavailable") this.refused.add(part);
      return;
    }
    this.fail(what, e);
  }

  /** The node's own row changed (it took the primary role, say): the lists it refused, asked again. */
  again(): void {
    if (this.refused.has("groups")) void this.loadGroups();
    if (this.refused.has("focus")) void this.loadFocus();
    if (this.refused.has("teammates")) void this.loadTeammates();
  }

  /** A group this side no longer keeps: its tab, its draft and what was open on it go. */
  private forget(id: string): void {
    const t = this.d.ui.team;
    t.drafts.delete(id);
    t.readSent.delete(id);
    if (t.replyTo?.group === id) t.replyTo = undefined;
    if (t.postError?.group === id) t.postError = undefined;
    if (t.complete?.group === id) t.complete = undefined;
    if (t.editGroup?.group === id) t.editGroup = undefined;
    if (t.groupMenu?.group === id) t.groupMenu = undefined;
    if (t.addMembers?.group === id) t.addMembers = undefined;
    if (this.d.ui.group === id) this.d.selectGroup(undefined);
  }

  // --- a group's posts ------------------------------------------------------------------------------

  /** A group's tab opened: its posts are asked for unless they are here and current. */
  opened(id: string): void {
    // with no line, they are asked for once it is back (`loadGroups`)
    if (!this.d.state.connected) return;
    const page = this.d.state.groupPosts.get(id);
    if (!page || !page.loaded || page.stale) void this.loadPosts(id);
  }

  /** The latest page of a group's posts, or (`earlier`) the one before those shown. */
  async loadPosts(group: string, earlier = false): Promise<void> {
    const page = this.d.state.groupPosts.get(group);
    if (page?.loading) return;
    const before = earlier && page?.loaded && !page.stale ? page.posts[0]?.n : undefined;
    if (earlier && before === undefined) return;
    this.d.dispatch({ type: "group.posts.loading", group });
    try {
      const r = await this.d.rpc.request<{ posts: GroupPost[]; more: boolean }>("group.posts", { group, ...(before !== undefined ? { before } : {}) });
      this.d.dispatch({ type: "group.posts", group, posts: r.posts, more: r.more, ...(before !== undefined ? { before } : {}) }, { anchor: before !== undefined });
    } catch (e) {
      this.d.dispatch({ type: "group.posts.failed", group });
      this.fail("group chat", e);
    }
  }

  /** After a draw: the user's own post in view, and what they read told once the end of the posts shows. */
  afterDraw(): void {
    if (this.toEnd) {
      this.toEnd = false;
      const stream = groupStream(this.d.roots.groups);
      if (stream) stream.scrollTop = stream.scrollHeight;
    }
    this.syncRead();
  }

  /** Tells the node the user read the group shown up to its last post, once the end of it is in view in a window that shows. */
  syncRead(): void {
    const { ui, state } = this.d;
    const id = ui.group;
    if (id === undefined || !state.connected || !state.scopes.includes("sessions:write") || document.visibilityState !== "visible") return;
    const g = state.groups.get(id);
    const page = state.groupPosts.get(id);
    const stream = groupStream(this.d.roots.groups);
    if (!g || !page?.loaded || page.stale || !stream) return;
    if (stream.scrollHeight - stream.scrollTop - stream.clientHeight > 24) return;
    const upTo = readUpTo(g, page);
    if (upTo === undefined || (ui.team.readSent.get(id) ?? 0) >= upTo) return;
    ui.team.readSent.set(id, upTo);
    this.d.rpc.request("group.read", { group: id, upTo }).catch(() => {
      if (ui.team.readSent.get(id) === upTo) ui.team.readSent.delete(id);
    });
  }

  private async post(form: HTMLFormElement): Promise<void> {
    const { ui } = this.d;
    const group = form.dataset["group"];
    const input = form.querySelector<HTMLTextAreaElement>(".group-text");
    if (!group || !input || input.disabled || ui.team.posting !== undefined) return;
    const text = input.value;
    const attached = this.media.forPost(group);
    if ("wait" in attached) {
      ui.team.postError = { group, text: attached.wait };
      this.d.draw();
      return;
    }
    const carries = attached.photos.length > 0 || attached.files.length > 0;
    if (text.trim() === "" && !carries) return;
    const replyTo = ui.team.replyTo?.group === group ? ui.team.replyTo.post : undefined;
    ui.team.posting = group;
    ui.team.postError = undefined;
    ui.team.complete = undefined;
    this.d.draw();
    try {
      const { post } = await this.d.rpc.request<{ post: GroupPost }>("group.post", {
        group,
        ...(text.trim() !== "" ? { text } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(attached.photos.length > 0 ? { photos: attached.photos } : {}),
        ...(attached.files.length > 0 ? { files: attached.files } : {}),
      });
      this.media.posted(group);
      this.d.dispatch({ type: "group.posted", params: { group, post } });
      if (input.value === text) {
        input.value = "";
        fitField(input);
      }
      ui.team.drafts.delete(group);
      if (ui.team.replyTo?.group === group) ui.team.replyTo = undefined;
      this.toEnd = true;
    } catch (e) {
      // the node's refusal, said in place: a post that tags no one, a group that ended, too many at once
      ui.team.postError = { group, text: this.words(e) };
    } finally {
      ui.team.posting = undefined;
      this.d.draw();
    }
  }

  private async react(post: string, on: boolean): Promise<void> {
    const group = this.d.ui.group;
    const key = `react:${post}`;
    if (group === undefined || this.d.ui.team.busy.has(key)) return;
    this.d.ui.team.busy.add(key);
    this.d.draw();
    try {
      // the post comes back with its thumbs, as `group.posted`
      await this.d.rpc.request("group.react", { group, post, on });
    } catch (e) {
      this.fail("thumbs up", e);
    } finally {
      this.d.ui.team.busy.delete(key);
      this.d.draw();
    }
  }

  // --- the composer's tags --------------------------------------------------------------------------

  /** The composer's text changed: kept as the group's draft, and the tags offered for an `@` before the caret. */
  private typed(input: HTMLTextAreaElement): void {
    fitField(input);
    const group = input.closest<HTMLElement>(".group-composer")?.dataset["group"];
    if (!group) return;
    this.d.ui.team.drafts.set(group, input.value);
    this.offer(input, group);
  }

  private offer(input: HTMLTextAreaElement, group: string): void {
    const t = this.d.ui.team;
    const g = this.d.state.groups.get(group);
    const caret = input.selectionStart ?? input.value.length;
    const c = g && input.selectionStart === input.selectionEnd ? tagCompletion(g, input.value, caret) : undefined;
    const before = t.complete;
    t.complete = c ? { group, start: c.start, caret, options: c.options, active: before?.group === group && before.start === c.start ? Math.min(before.active, c.options.length - 1) : 0 } : undefined;
    if (before !== undefined || c !== undefined) this.d.draw();
  }

  /** One of the tags offered, written in where the `@` is. */
  private pick(index: number): void {
    const t = this.d.ui.team;
    const c = t.complete;
    const input = this.d.roots.groups.querySelector<HTMLTextAreaElement>(".group-text");
    const choice = c?.options[index];
    if (!c || !input || choice === undefined) return;
    const caret = input.selectionStart ?? c.caret;
    const r = completeTag(input.value, c.start, caret, choice);
    input.value = r.text;
    input.focus();
    input.setSelectionRange(r.caret, r.caret);
    fitField(input);
    t.drafts.set(c.group, r.text);
    t.complete = undefined;
    this.d.draw();
  }

  // --- a group's head -------------------------------------------------------------------------------

  private async saveGroup(form: HTMLFormElement): Promise<void> {
    const edit = this.d.ui.team.editGroup;
    if (!edit || edit.busy) return;
    const name = form.querySelector<HTMLInputElement>(".group-edit-name")?.value.trim() ?? "";
    const purpose = form.querySelector<HTMLInputElement>(".group-edit-purpose")?.value.trim() ?? "";
    if (name === "") {
      edit.error = "A group needs a name.";
      this.d.draw();
      return;
    }
    edit.busy = true;
    edit.error = undefined;
    this.d.draw();
    try {
      // an empty purpose clears it
      const r = await this.d.rpc.request<{ group: Group }>("group.update", { group: edit.group, name, purpose });
      this.d.dispatch({ type: "group.state", params: r.group });
      if (this.d.ui.team.editGroup === edit) this.d.ui.team.editGroup = undefined;
    } catch (e) {
      edit.error = this.words(e);
    } finally {
      edit.busy = false;
      this.d.draw();
    }
  }

  /** Delete or End, once the user confirmed it in place. */
  private async confirmAsk(): Promise<void> {
    const m = this.d.ui.team.groupMenu;
    if (!m?.asking || m.busy) return;
    m.busy = true;
    m.error = undefined;
    this.d.draw();
    try {
      if (m.asking === "delete") {
        await this.d.rpc.request("group.delete", { group: m.group });
        const g = this.d.state.groups.get(m.group);
        if (g) this.d.dispatch({ type: "group.state", params: { ...g, left: true } });
        this.forget(m.group);
      } else await this.d.rpc.request("group.end", { group: m.group });
      if (this.d.ui.team.groupMenu === m) this.d.ui.team.groupMenu = undefined;
    } catch (e) {
      m.error = this.words(e);
    } finally {
      m.busy = false;
      this.d.draw();
    }
  }

  /** One of the user's own agents told of every post or the tags only, or a member taken out. */
  private async member(member: string, notify?: GroupNotify): Promise<void> {
    const group = this.d.ui.group;
    const key = `member:${group}\n${member}`;
    if (group === undefined || this.d.ui.team.busy.has(key)) return;
    this.d.ui.team.busy.add(key);
    this.d.draw();
    try {
      const r = notify !== undefined ? await this.d.rpc.request<{ group: Group }>("group.member.set", { group, member, notify }) : await this.d.rpc.request<{ group: Group }>("group.member.remove", { group, member });
      this.d.dispatch({ type: "group.state", params: r.group });
    } catch (e) {
      this.fail(notify !== undefined ? "the agent's setting" : "taking the agent out", e);
    } finally {
      this.d.ui.team.busy.delete(key);
      this.d.draw();
    }
  }

  /** The agents a group may take, into a picker. */
  private async listCandidates(p: AgentPick): Promise<void> {
    try {
      const { agents } = await this.d.rpc.request<{ agents: GroupCandidate[] }>("group.candidates", {});
      p.candidates = agents;
      p.loadError = undefined;
    } catch (e) {
      p.candidates = [];
      p.loadError = this.words(e);
    }
    this.d.draw();
  }

  private async addMembers(): Promise<void> {
    const f = this.d.ui.team.addMembers;
    if (!f || f.busy || f.picked.size === 0) return;
    const members = (f.candidates ?? []).filter((c) => f.picked.has(candidateKey(c.ref))).map((c) => c.ref);
    f.busy = true;
    f.error = undefined;
    this.d.draw();
    try {
      const r = await this.d.rpc.request<{ group: Group }>("group.member.add", { group: f.group, members });
      this.d.dispatch({ type: "group.state", params: r.group });
      if (this.d.ui.team.addMembers === f) this.d.ui.team.addMembers = undefined;
    } catch (e) {
      f.error = this.words(e);
    } finally {
      f.busy = false;
      this.d.draw();
    }
  }

  // --- New group --------------------------------------------------------------------------------------

  openNewGroup(): void {
    const { ui } = this.d;
    ui.railMenu = undefined;
    ui.devices = undefined;
    ui.contextOpen = false;
    this.closeOverlay();
    const f: NewGroupForm = { picked: new Set(), notify: "tags" };
    ui.team.newGroup = f;
    this.d.putRailAway();
    this.d.draw();
    this.d.roots.team.querySelector<HTMLFormElement>(".group-new-form")?.reset();
    if (!this.d.phone()) this.d.roots.team.querySelector<HTMLInputElement>(".group-new-name")?.focus();
    void this.listCandidates(f);
  }

  private async createGroup(form: HTMLFormElement): Promise<void> {
    const f = this.d.ui.team.newGroup;
    if (!f || f.busy) return;
    const made = groupCreateParams(
      { name: form.querySelector<HTMLInputElement>(".group-new-name")?.value ?? "", purpose: form.querySelector<HTMLInputElement>(".group-new-purpose")?.value ?? "", notify: f.notify, picked: f.picked },
      f.candidates ?? [],
    );
    if ("error" in made) {
      f.error = made.error;
      this.d.draw();
      return;
    }
    f.busy = true;
    f.error = undefined;
    this.d.draw();
    try {
      const { group } = await this.d.rpc.request<{ group: Group }>("group.create", made.params);
      this.d.dispatch({ type: "group.state", params: group });
      if (this.d.ui.team.newGroup === f) {
        this.d.ui.team.newGroup = undefined;
        form.reset();
      }
      this.d.selectGroup(group.id);
    } catch (e) {
      f.error = this.words(e);
    } finally {
      f.busy = false;
      this.d.draw();
    }
  }

  // --- Teammates ----------------------------------------------------------------------------------------

  openPage(): void {
    const { ui, state } = this.d;
    ui.railMenu = undefined;
    ui.devices = undefined;
    ui.contextOpen = false;
    ui.team.newGroup = undefined;
    ui.team.page ??= { errorsAt: state.errorsSeen };
    this.d.putRailAway();
    this.d.draw();
    this.d.roots.team.querySelector<HTMLElement>(".devices-body")?.focus({ preventScroll: true });
    void this.loadTeammates();
    void this.loadWorkspaces();
  }

  /** New group and Teammates leave the panes: a tab picked, Devices opened, Escape or ×. */
  closeOverlay(): void {
    const t = this.d.ui.team;
    t.page = undefined;
    t.newGroup = undefined;
    t.share = undefined;
    t.ending = undefined;
  }

  /** Whether New group or Teammates lies over the panes. */
  overlayShown(): boolean {
    return this.d.ui.team.page !== undefined || this.d.ui.team.newGroup !== undefined;
  }

  private async loadWorkspaces(): Promise<void> {
    if (!this.d.state.scopes.includes("sessions:read")) return;
    try {
      const { workspaces } = await this.d.rpc.request<{ workspaces: Workspace[] }>("workspace.list", {});
      this.d.ui.team.workspaces = workspaces;
      this.d.draw();
    } catch {
      // the rows from the connect name them
    }
  }

  /** Each machine's home folder and roots, as its folder listing says: a share of one is asked about. Unknown, the usual homes stand for it. */
  private async loadHomes(): Promise<void> {
    const { state, ui } = this.d;
    if (!state.scopes.includes("terminal")) return;
    const nodes = new Set<string>();
    if (state.node) nodes.add(state.node);
    for (const n of state.nodes.values()) if (n.status === "online" && n.scope.kind !== "workspaces") nodes.add(n.id);
    await Promise.all(
      [...nodes]
        .filter((n) => !ui.team.homes.has(n))
        .map(async (node) => {
          try {
            const listing = await this.d.rpc.request<FolderPick>("terminal.folders", node !== state.node ? { node } : {});
            ui.team.homes.set(node, { home: listing.home, roots: listing.roots });
          } catch {
            // the usual homes stand for it
          }
        }),
    );
  }

  /** The share form, opened to invite, to use a code, or (`teammate`) to change what is shared with one. */
  private openShare(kind: ShareForm["kind"], teammate?: string): void {
    const { state, ui } = this.d;
    const t = teammate !== undefined ? state.teammates.get(teammate) : undefined;
    if (kind === "edit" && !t) return;
    const picked = new Map<string, TeammatePlace>();
    for (const p of t?.share.folders ?? []) picked.set(folderKey(state, p), { node: p.node, path: p.path });
    ui.team.share = { kind, ...(teammate !== undefined ? { teammate } : {}), mode: t?.share.mode ?? "include", picked, open: t?.share.open ?? "always" };
    ui.team.ending = undefined;
    this.d.draw();
    const form = this.d.roots.team.querySelector<HTMLElement>(".team-share");
    if (!this.d.phone()) form?.querySelector<HTMLElement>(kind === "accept" ? ".team-code-input" : ".team-choice-option[aria-pressed='true']")?.focus();
    void this.loadHomes().then(() => this.d.draw());
  }

  /** Other folder…: the picker in place of the machines, on that machine, at its home. */
  private browse(node: string, name: string): void {
    const f = this.d.ui.team.share;
    if (!f || f.busy) return;
    f.browse = { node, name };
    this.d.draw();
    if (!this.d.phone()) this.d.roots.team.querySelector<HTMLInputElement>(".team-share .folder-path")?.focus();
    void this.openFolder(this.d.ui.folderAt.get(node));
  }

  private async openFolder(path: string | undefined): Promise<void> {
    const b = this.d.ui.team.share?.browse;
    if (!b) return;
    const asked = path ?? "~";
    b.loading = asked;
    b.error = undefined;
    this.d.draw();
    try {
      const listing = await this.d.rpc.request<FolderPick>("terminal.folders", { ...(b.node !== this.d.state.node ? { node: b.node } : {}), ...(path !== undefined ? { path } : {}) });
      if (this.d.ui.team.share?.browse !== b || b.loading !== asked) return;
      b.listing = listing;
      this.d.ui.team.homes.set(b.node, { home: listing.home, roots: listing.roots });
    } catch (e) {
      if (this.d.ui.team.share?.browse !== b || b.loading !== asked) return;
      b.error = e instanceof ViewRpcError && e.code === "unsupported" && !b.listing ? "This app or that computer cannot list folders yet: update it." : e instanceof Error ? e.message : String(e);
    }
    b.loading = undefined;
    this.d.draw();
    this.d.roots.team.querySelector(".team-share .folder-list")?.scrollTo({ top: 0 });
  }

  /** Share this folder: ticked, and the picker gives way to the machines again. */
  private folderHere(): void {
    const f = this.d.ui.team.share;
    const b = f?.browse;
    if (!f || !b?.listing) return;
    const place = { node: b.node, path: b.listing.path };
    f.picked.set(folderKey(this.d.state, place), place);
    f.browse = undefined;
    this.changedShare(f);
    this.d.draw();
  }

  /** The share changed: a question asked of the one before is asked again of this one. */
  private changedShare(f: ShareForm): void {
    f.broad = undefined;
    f.broadOk = false;
    f.error = undefined;
  }

  private async submitShare(): Promise<void> {
    const { state, ui } = this.d;
    const f = ui.team.share;
    if (!f || f.busy) return;
    const t = f.teammate !== undefined ? state.teammates.get(f.teammate) : undefined;
    const share = buildShare(f.mode, [...f.picked.values()], f.open, t?.share);
    if (share.mode === "include" && share.folders.length === 0) {
      f.error = "Tick the folders to share, or pick Exclude to share every workspace but some.";
      this.d.draw();
      return;
    }
    const codeBox = this.d.roots.team.querySelector<HTMLTextAreaElement>(".team-code-input");
    const code = f.kind === "accept" ? (codeBox?.value ?? "").trim() : "";
    if (f.kind === "accept" && code === "") {
      f.error = "Paste the code they gave you.";
      this.d.draw();
      codeBox?.focus();
      return;
    }
    // A whole home folder or a drive opens every project on it: asked in place first.
    if (!f.broadOk) {
      const broad = broadShares(share, ui.team.homes, (n) => state.nodes.get(n)?.platform);
      if (broad.length > 0) {
        f.broad = broad;
        f.error = undefined;
        this.d.draw();
        return;
      }
    }
    f.busy = true;
    f.error = undefined;
    ui.team.pageBusy = true;
    this.d.draw();
    try {
      if (f.kind === "invite") {
        const r = await this.d.rpc.request<{ teammate: Teammate; invite: { code: string; expiresAt: number } }>("teammate.invite", { share });
        this.d.dispatch({ type: "teammate.state", params: r.teammate });
        this.d.dispatch({ type: "teammate.code", code: { id: r.teammate.id, code: r.invite.code, expiresAt: r.invite.expiresAt } });
        ui.team.copied = undefined;
      } else if (f.kind === "accept") {
        const r = await this.d.rpc.request<{ teammate: Teammate }>("teammate.accept", { code, share });
        this.d.dispatch({ type: "teammate.state", params: r.teammate });
        if (codeBox) codeBox.value = "";
      } else {
        const r = await this.d.rpc.request<{ teammate: Teammate }>("teammate.update", { id: f.teammate, share });
        this.d.dispatch({ type: "teammate.state", params: r.teammate });
      }
      if (ui.team.share === f) ui.team.share = undefined;
    } catch (e) {
      f.error = this.words(e);
      f.broadOk = false;
    } finally {
      f.busy = false;
      ui.team.pageBusy = false;
      this.d.draw();
    }
  }

  /** A teammate ended at both sides, or a code not used yet cancelled. */
  private async endTeammate(id: string, how: "end" | "cancel"): Promise<void> {
    const { ui, state } = this.d;
    ui.team.ending = undefined;
    ui.team.pageBusy = true;
    this.d.draw();
    try {
      await this.d.rpc.request(how === "end" ? "teammate.end" : "teammate.cancel", { id });
      const t = state.teammates.get(id);
      if (t) this.d.dispatch({ type: "teammate.state", params: { ...t, state: "ended" } });
      if (ui.team.share?.teammate === id) ui.team.share = undefined;
    } catch (e) {
      this.fail("teammates", e);
    } finally {
      ui.team.pageBusy = false;
      this.d.draw();
    }
  }

  private async copyCode(): Promise<void> {
    const code = this.d.state.teammateCode;
    if (!code) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(code.code);
      ok = true;
    } catch {
      const box = this.d.roots.team.querySelector<HTMLTextAreaElement>(".team-code .invite-text");
      if (box) {
        box.focus();
        box.select();
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
      }
    }
    this.d.ui.team.copied = { id: code.id, ok };
    this.d.draw();
  }

  /** A folder shared closed with a teammate, opened to them or excluded from their share. */
  private async placeAction(key: string, how: "open" | "exclude"): Promise<void> {
    const { state, ui } = this.d;
    const row = closedPlaces(state).find((r) => r.key === key);
    const t = row ? state.teammates.get(row.teammate) : undefined;
    const busy = `place:${key}`;
    if (!row || !t || ui.team.busy.has(busy)) return;
    const platform = state.nodes.get(row.place.node)?.platform;
    const share = how === "open" ? openPlace(t.share, row.place, platform) : excludePlace(t.share, row.place, platform);
    ui.team.busy.add(busy);
    this.d.draw();
    try {
      const r = await this.d.rpc.request<{ teammate: Teammate }>("teammate.update", { id: t.id, share });
      this.d.dispatch({ type: "teammate.state", params: r.teammate });
    } catch (e) {
      this.fail("teammates", e);
    } finally {
      ui.team.busy.delete(busy);
      this.d.draw();
    }
  }

  /** A session opened to a teammate by hand, or closed to them again. */
  private async openTo(teammate: string, session: string, on: boolean): Promise<void> {
    const busy = `open:${teammate}\n${session}`;
    if (this.d.ui.team.busy.has(busy)) return;
    this.d.ui.team.busy.add(busy);
    this.d.draw();
    try {
      const r = await this.d.rpc.request<{ teammate: Teammate }>("teammate.open", { teammate, session, on });
      this.d.dispatch({ type: "teammate.state", params: r.teammate });
    } catch (e) {
      this.fail("teammates", e);
    } finally {
      this.d.ui.team.busy.delete(busy);
      this.d.draw();
    }
  }

  private async endFocus(session: string): Promise<void> {
    const busy = `focus:${session}`;
    if (this.d.ui.team.busy.has(busy)) return;
    this.d.ui.team.busy.add(busy);
    this.d.draw();
    try {
      await this.d.rpc.request("focus.end", { session });
      this.d.dispatch({ type: "focus.state", params: { session } });
    } catch (e) {
      this.fail("focus", e);
    } finally {
      this.d.ui.team.busy.delete(busy);
      this.d.draw();
    }
  }

  // --- the user ------------------------------------------------------------------------------------------

  /** A click anywhere: a group's ⋮ and the tags offered close unless it was in them. */
  outside(target: Element | null): void {
    const t = this.d.ui.team;
    let changed = false;
    if (t.groupMenu && t.groupMenu.asking === undefined && !target?.closest(".group-menu, .group-more")) {
      t.groupMenu = undefined;
      changed = true;
    }
    if (t.complete && !target?.closest(".group-complete, .group-text")) {
      t.complete = undefined;
      changed = true;
    }
    if (changed) this.d.draw();
  }

  /** A press on one of these parts' buttons; false for any other. */
  click(target: HTMLElement): boolean {
    const { ui } = this.d;
    const t = ui.team;
    const data = target.dataset;
    if (this.media.click(target, ui.group)) return true;
    switch (data["action"]) {
      // the share form's folder picker, which New terminal's and Send to…'s are too
      case "folder-open":
        if (!target.closest(".team-share")) return false;
        if (data["path"] !== undefined) void this.openFolder(data["path"]);
        return true;
      case "folder-back":
        if (!target.closest(".team-share")) return false;
        if (t.share) t.share.browse = undefined;
        this.d.draw();
        return true;
      case "select-group":
        if (data["chat"]) this.d.selectGroup(data["chat"]);
        return true;
      case "group-new":
        this.openNewGroup();
        return true;
      case "team-open":
        this.openPage();
        return true;
      case "team-close":
        this.closeOverlay();
        this.d.draw();
        return true;
      case "group-new-notify":
        if (t.newGroup && (data["notify"] === "all" || data["notify"] === "tags")) t.newGroup.notify = data["notify"];
        this.d.draw();
        return true;
      case "group-earlier":
        if (ui.group !== undefined) void this.loadPosts(ui.group, true);
        return true;
      case "group-react":
        if (data["post"]) void this.react(data["post"], data["on"] === "true");
        return true;
      case "group-reply":
        if (ui.group !== undefined && data["post"]) t.replyTo = { group: ui.group, post: data["post"] };
        this.d.draw();
        this.d.roots.groups.querySelector<HTMLTextAreaElement>(".group-text")?.focus();
        return true;
      case "group-reply-cancel":
        t.replyTo = undefined;
        this.d.draw();
        return true;
      case "group-complete-pick":
        this.pick(Number(data["index"]));
        return true;
      case "group-edit":
        if (ui.group !== undefined) t.editGroup = { group: ui.group };
        this.d.draw();
        this.d.roots.groups.querySelector<HTMLInputElement>(".group-edit-name")?.focus();
        return true;
      case "group-edit-cancel":
        t.editGroup = undefined;
        this.d.draw();
        return true;
      case "group-menu":
        t.groupMenu = t.groupMenu?.group === ui.group || ui.group === undefined ? undefined : { group: ui.group };
        this.d.draw();
        if (t.groupMenu) this.d.roots.groups.querySelector<HTMLButtonElement>(".group-menu .rail-menu-item:not([hidden])")?.focus();
        return true;
      case "group-delete-ask":
      case "group-end-ask":
        if (ui.group !== undefined) t.groupMenu = { group: ui.group, asking: data["action"] === "group-delete-ask" ? "delete" : "end" };
        this.d.draw();
        return true;
      case "group-ask-confirm":
        void this.confirmAsk();
        return true;
      case "group-ask-cancel":
        if (!t.groupMenu?.busy) t.groupMenu = undefined;
        this.d.draw();
        return true;
      case "group-member-notify":
        if (data["member"] && (data["notify"] === "all" || data["notify"] === "tags")) void this.member(data["member"], data["notify"]);
        return true;
      case "group-member-remove":
        if (data["member"]) void this.member(data["member"]);
        return true;
      case "group-add": {
        if (ui.group === undefined) return true;
        const f = { group: ui.group, picked: new Set<string>() };
        t.addMembers = f;
        this.d.draw();
        void this.listCandidates(f);
        return true;
      }
      case "group-add-confirm":
        void this.addMembers();
        return true;
      case "group-add-cancel":
        if (!t.addMembers?.busy) t.addMembers = undefined;
        this.d.draw();
        return true;
      case "focus-end":
        if (data["session"]) void this.endFocus(data["session"]);
        return true;
      case "teammate-open":
        if (data["teammate"] && data["session"]) void this.openTo(data["teammate"], data["session"], data["on"] === "true");
        return true;
      case "team-place-open":
      case "team-place-exclude":
        if (data["key"]) void this.placeAction(data["key"], data["action"] === "team-place-open" ? "open" : "exclude");
        return true;
      case "team-share-invite":
        this.openShare("invite");
        return true;
      case "team-share-accept":
        this.openShare("accept");
        return true;
      case "team-edit":
        if (data["id"]) this.openShare("edit", data["id"]);
        return true;
      case "team-share-close":
        if (!t.share?.busy) t.share = undefined;
        this.d.draw();
        return true;
      case "team-share-mode":
        if (t.share && (data["mode"] === "include" || data["mode"] === "exclude")) {
          t.share.mode = data["mode"];
          this.changedShare(t.share);
        }
        this.d.draw();
        return true;
      case "team-share-open":
        if (t.share && (data["open"] === "always" || data["open"] === "chosen")) t.share.open = data["open"];
        this.d.draw();
        return true;
      case "team-share-browse":
        if (data["node"]) this.browse(data["node"], data["name"] ?? "");
        return true;
      case "team-folder-here":
        this.folderHere();
        return true;
      case "team-share-submit":
        void this.submitShare();
        return true;
      case "team-broad-ok":
        if (t.share) {
          t.share.broadOk = true;
          t.share.broad = undefined;
        }
        void this.submitShare();
        return true;
      case "team-broad-back":
        if (t.share) t.share.broad = undefined;
        this.d.draw();
        this.d.roots.team.querySelector<HTMLInputElement>(".team-share .team-folder-check")?.focus();
        return true;
      case "team-end":
        t.ending = data["id"];
        this.d.draw();
        return true;
      case "team-end-confirm":
        if (data["id"]) void this.endTeammate(data["id"], "end");
        return true;
      case "team-end-cancel":
        t.ending = undefined;
        this.d.draw();
        return true;
      case "team-cancel":
        if (data["id"]) void this.endTeammate(data["id"], "cancel");
        return true;
      case "team-code-copy":
        void this.copyCode();
        return true;
      case "team-code-done":
        t.copied = undefined;
        this.d.dispatch({ type: "teammate.code" });
        void this.loadTeammates();
        return true;
      default:
        return false;
    }
  }

  /** A form of these parts sent: the composer, New group, a group's name and purpose, the share form's path. */
  submit(form: HTMLFormElement): boolean {
    if (form.classList.contains("folder-go") && form.closest(".team-share")) {
      const typed = form.querySelector<HTMLInputElement>(".folder-path")?.value.trim();
      if (typed) void this.openFolder(typed);
      return true;
    }
    if (form.classList.contains("group-composer")) {
      void this.post(form);
      return true;
    }
    if (form.classList.contains("group-new-form")) {
      void this.createGroup(form);
      return true;
    }
    if (form.classList.contains("group-edit-form")) {
      void this.saveGroup(form);
      return true;
    }
    return false;
  }

  /** Typing in the composer: its draft, and the tags offered. */
  input(target: HTMLElement): boolean {
    if (!target.classList.contains("group-text")) return false;
    this.typed(target as HTMLTextAreaElement);
    return true;
  }

  /** A box ticked: an agent for a group, or a folder to share. */
  change(target: HTMLElement): boolean {
    const { ui } = this.d;
    if (this.media.change(target, ui.group)) return true;
    if (target.classList.contains("agent-pick-check")) {
      const key = target.dataset["key"];
      const p = target.closest<HTMLElement>(".agent-pick")?.dataset["for"] === "new" ? ui.team.newGroup : ui.team.addMembers;
      if (p && key) {
        if ((target as HTMLInputElement).checked) p.picked.add(key);
        else p.picked.delete(key);
        p.error = undefined;
      }
      this.d.draw();
      return true;
    }
    if (target.classList.contains("team-folder-check")) {
      const f = ui.team.share;
      const { key, node, path } = target.dataset;
      if (f && key && node && path) {
        if ((target as HTMLInputElement).checked) f.picked.set(key, { node, path });
        else f.picked.delete(key);
        this.changedShare(f);
      }
      this.d.draw();
      return true;
    }
    return false;
  }

  /** In the composer, the arrow keys move along the tags offered and Enter or Tab writes one in; else Enter posts and Shift+Enter starts a line. */
  keydown(ev: KeyboardEvent): boolean {
    const input = ev.target as HTMLElement | null;
    if (!input?.matches?.(".group-text") || ev.isComposing) return false;
    const c = this.d.ui.team.complete;
    if (c && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
      ev.preventDefault();
      const n = c.options.length;
      c.active = (c.active + (ev.key === "ArrowDown" ? 1 : -1) + n) % n;
      this.d.draw();
      return true;
    }
    if (c && (ev.key === "Enter" || ev.key === "Tab") && !ev.shiftKey) {
      ev.preventDefault();
      this.pick(c.active);
      return true;
    }
    if (enterSends(ev)) {
      ev.preventDefault();
      input.closest("form")?.requestSubmit();
      return true;
    }
    return false;
  }

  /**
   * Escape, innermost first: the tags offered; over the panes, the share form's question, its
   * picker, End's question, the form, then New group or Teammates themselves; in a group's
   * pane, its ⋮ or its question, its name being changed, Add, then the post being answered.
   */
  escape(): boolean {
    const t = this.d.ui.team;
    const draw = (): true => {
      this.d.draw();
      return true;
    };
    if (t.complete) {
      t.complete = undefined;
      return draw();
    }
    if (this.media.escape()) return true;
    if (this.overlayShown()) {
      if (t.share?.broad) t.share.broad = undefined;
      else if (t.share?.browse) t.share.browse = undefined;
      else if (t.ending !== undefined) t.ending = undefined;
      else if (t.share && !t.share.busy) t.share = undefined;
      else this.closeOverlay();
      return draw();
    }
    if (this.d.ui.group === undefined) return false;
    if (t.groupMenu && !t.groupMenu.busy) {
      t.groupMenu = undefined;
      draw();
      this.d.roots.groups.querySelector<HTMLButtonElement>(".group-more")?.focus();
      return true;
    }
    if (t.editGroup && !t.editGroup.busy) {
      t.editGroup = undefined;
      return draw();
    }
    if (t.addMembers && !t.addMembers.busy) {
      t.addMembers = undefined;
      return draw();
    }
    if (t.replyTo) {
      t.replyTo = undefined;
      return draw();
    }
    return false;
  }
}
