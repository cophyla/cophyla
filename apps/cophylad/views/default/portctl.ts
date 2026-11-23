// Machines' Web pages on the host's line: what listens on each machine with a block, asked as
// Devices opens and on Refresh (`ports.list`), the ports this client opened folded in as the
// node says them (`port.state`), and the block's presses. Open asks the node this view talks to
// (`port.open`): the phone app gets a share its own forwarder reads the page through, so the
// host shows it (`host.open {port}`); the desktop app gets the page's address on this computer,
// which its browser opens (`host.openLink`), unless the click is no longer fresh by the time
// the answer comes, when the row's own Open opens it. A port already open here is opened again
// rather than asked for twice. Why an Open did not go shows under the block, in the node's
// words: a machine reached only through the relay, say, whose pages do not open. DOM-free: the
// presses come as what the page's elements carry.

import type { ListeningPort, PortForward } from "@cophyla/protocol";
import type { Action, ViewState } from "./model.ts";
import { machineName } from "./model.ts";
import { openingKey, portNumber, portOpenStep, selectPorts } from "./portmodel.ts";
import type { PortOpened, PortsUi } from "./portmodel.ts";

/** What the blocks need of the host's line. */
export interface PortsRpc {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/** A pressed element, as far as the blocks read it: its data, and the block it is in. */
export interface PortsTarget {
  dataset: { [name: string]: string | undefined };
  closest?(selector: string): { dataset: { [name: string]: string | undefined } } | null;
}

/** A submitted form, as far as the blocks read it: its class, its machine, and its field. */
export interface PortsForm {
  classList: { contains(name: string): boolean };
  dataset: { [name: string]: string | undefined };
  querySelector(selector: string): { value: string } | null;
}

export interface PortsDeps {
  rpc: PortsRpc;
  state: ViewState;
  ui: { ports: PortsUi };
  dispatch: (action: Action) => void;
  draw: () => void;
}

export class PortsControl {
  private d: PortsDeps;

  constructor(deps: PortsDeps) {
    this.d = deps;
  }

  /** Devices opened: what listens on every machine whose block shows, asked afresh. */
  devicesOpened(): void {
    for (const node of this.d.state.nodes.values()) if (selectPorts(this.d.state, node)) void this.list(node.id);
  }

  /** The line went: what was on its way is gone with it, and so is why an Open did not go. */
  disconnected(): void {
    const p = this.d.ui.ports;
    p.opening.clear();
    p.closing.clear();
    p.errors.clear();
  }

  /** A notice for the blocks, folded in; false for any other. */
  notification(method: string, params: unknown): boolean {
    if (method !== "port.state") return false;
    this.d.dispatch({ type: "port.state", params: params as { forwards: PortForward[] } });
    return true;
  }

  /** A press in a block; false for any other. */
  click(target: PortsTarget): boolean {
    const data = target.dataset;
    switch (data["action"]) {
      case "ports-refresh": {
        const node = target.closest?.(".node-ports")?.dataset["node"] ?? data["node"];
        if (node) void this.list(node);
        return true;
      }
      case "port-open": {
        const port = Number(data["port"]);
        if (data["node"] && Number.isInteger(port)) void this.open(data["node"], port);
        return true;
      }
      case "port-link":
        if (data["url"]) this.link(data["url"]);
        return true;
      case "port-close":
        if (data["id"]) void this.close(data["id"]);
        return true;
      default:
        return false;
    }
  }

  /** The block's field: the port typed, opened; false for any other form. */
  submit(form: PortsForm): boolean {
    if (!form.classList.contains("ports-form")) return false;
    const node = form.dataset["node"];
    const field = form.querySelector(".ports-port");
    const port = portNumber(field?.value ?? "");
    if (!node) return true;
    if (port === undefined) {
      this.d.ui.ports.errors.set(node, "A port is a number from 1 to 65535.");
      this.d.draw();
      return true;
    }
    if (field) field.value = "";
    void this.open(node, port);
    return true;
  }

  async list(node: string): Promise<void> {
    if (!this.d.state.scopes.includes("remote")) return;
    this.d.dispatch({ type: "ports.loading", node });
    try {
      const { ports } = await this.d.rpc.request<{ ports: ListeningPort[] }>("ports.list", { node });
      this.d.dispatch({ type: "ports", node, ports });
    } catch (e) {
      this.d.dispatch({ type: "ports", node, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Opens a port of a machine's here: the one open already, or asked of the node, then shown where this client shows a page. */
  async open(node: string, port: number): Promise<void> {
    const { state, ui, rpc } = this.d;
    const key = openingKey(node, port);
    if (!state.scopes.includes("remote") || ui.ports.opening.has(key)) return;
    const already = [...state.forwards.values()].find((f) => f.node === node && f.port === port && f.url !== undefined);
    if (already?.url !== undefined) {
      this.link(already.url);
      return;
    }
    ui.ports.errors.delete(node);
    ui.ports.opening.add(key);
    this.d.draw();
    try {
      const opened = await rpc.request<PortOpened>("port.open", { node, port });
      const step = portOpenStep(opened, machineName(state, node));
      if (step.kind === "host.open") {
        try {
          await rpc.request("host.open", step.params);
        } catch (e) {
          // an app that cannot show it: the port is not left open for nothing
          void rpc.request("port.close", { id: opened.id }).catch(() => undefined);
          throw e;
        }
      } else if (step.kind === "link") this.link(step.url);
    } catch (e) {
      ui.ports.errors.set(node, e instanceof Error ? e.message : String(e));
    } finally {
      ui.ports.opening.delete(key);
      this.d.draw();
    }
  }

  /** A page opened in this computer's browser; a click no longer fresh opens nothing, and the row's Open is there for it. */
  private link(url: string): void {
    void this.d.rpc.request("host.openLink", { url }).catch(() => undefined);
  }

  private async close(id: string): Promise<void> {
    const { state, ui, rpc } = this.d;
    if (ui.ports.closing.has(id)) return;
    const node = state.forwards.get(id)?.node;
    ui.ports.closing.add(id);
    this.d.draw();
    try {
      await rpc.request("port.close", { id });
    } catch (e) {
      if (node) ui.ports.errors.set(node, e instanceof Error ? e.message : String(e));
    } finally {
      ui.ports.closing.delete(id);
      this.d.draw();
    }
  }
}
