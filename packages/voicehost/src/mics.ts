// Which microphone the host listens on. The user may pick one (the desktop's Settings) or
// leave it to the system's default. A pick is kept by the id the web view gave the device and
// by its name, since the id can move while the name stays. A pick that is not connected falls
// back to the default until it is. The default is followed as it moves: when the system makes
// another device its default (a headset plugged in, a dongle pulled), the host moves with it.
// A microphone that went away ends its track and sends nothing more, so the host asks again
// for whatever is there now, and says so. Pure but for `listMics`, which asks the web view.

/** A device the user picked: the web view's id for it, and its name for when the id moves. */
export interface MicChoice {
  id: string;
  label: string;
}

/** A microphone the web view lists. */
export interface MicDevice {
  id: string;
  label: string;
  groupId: string;
}

/** The microphones there are, and which of them the system's default is when the web view says. */
export interface MicList {
  devices: MicDevice[];
  /** The default's name, without the web view's "Default - " before it. */
  defaultLabel?: string;
  /** The default's group, the same as the real device's it stands for. */
  defaultGroup?: string;
}

/** The device the microphone runs on now, from its track. */
export interface MicInUse {
  id?: string;
  label: string;
  groupId?: string;
}

/** The part of `navigator.mediaDevices` that lists devices. */
export interface DeviceLister {
  enumerateDevices(): Promise<{ kind: string; deviceId: string; label: string; groupId: string }[]>;
}

/**
 * Chromium lists the system's default and its communications device again under the ids
 * `default` and `communications`, named "Default - …" and "Communications - …": those two are
 * where the default is read from, never devices of their own.
 */
const ALIASES = new Set(["default", "communications", ""]);

export async function listMics(media: DeviceLister): Promise<MicList> {
  const inputs = (await media.enumerateDevices()).filter((d) => d.kind === "audioinput");
  const list: MicList = {
    devices: inputs.filter((d) => !ALIASES.has(d.deviceId)).map((d) => ({ id: d.deviceId, label: d.label || "A microphone", groupId: d.groupId })),
  };
  const def = inputs.find((d) => d.deviceId === "default");
  if (def) {
    if (def.label) list.defaultLabel = def.label.replace(/^Default - /, "");
    if (def.groupId) list.defaultGroup = def.groupId;
  }
  return list;
}

/** What to ask for: the picked device by its id, or by its name when the id moved; none (the default) when it is not connected, and whose it was. */
export function resolveMic(choice: MicChoice | undefined, list: MicList): { id?: string; missing?: string } {
  if (!choice) return {};
  const found = list.devices.find((d) => d.id === choice.id) ?? list.devices.find((d) => d.label === choice.label);
  return found ? { id: found.id } : { missing: choice.label };
}

/**
 * The microphone runs on a device other than the one it should: the pick, now that it is
 * connected, or the system's default, which moved. False while there is nothing to tell (a
 * web view that does not say its default, a track that does not say its group).
 */
export function micMisplaced(current: MicInUse, choice: MicChoice | undefined, list: MicList): boolean {
  const want = resolveMic(choice, list);
  if (want.id !== undefined) return current.id !== want.id;
  if (list.defaultGroup === undefined || current.groupId === undefined) return false;
  return current.groupId !== list.defaultGroup;
}

/** Why the microphone could not be had, in the user's words rather than the web view's. */
export function micWords(e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "the microphone was not allowed";
    case "NotFoundError":
      return "no microphone is connected";
    case "OverconstrainedError":
      return "the microphone picked is not connected";
    case "NotReadableError":
    case "AbortError":
      return "the microphone could not be read: another app may hold it, or it was just unplugged";
    default:
      return e instanceof Error ? e.message : String(e);
  }
}
