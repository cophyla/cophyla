// The group chat methods: a client lists the groups and the agents they may take, pages a
// group's posts, makes a group, changes it, posts and gives a thumbs up as the user, marks what
// the user read, ends a group, drops its copy, and puts agents in or takes them out
// (`group.*`, `sessions:read` to read and `sessions:write` to change, refused to limited access
// by the filter tables, since a group spans workspaces). A post's photos and files: the bytes an
// app uploads for one, a photo read a piece at a time, and a file saved to one of the user's
// machines (`group.file.save`, the `terminal` scope's, as a transfer is). And focus: which agents are in it,
// and ending one's. The groups are the primary's: a client of a secondary is the primary's
// client, and its requests are answered there.

import { RpcError } from "@cophyla/protocol";
import type { MethodTable } from "../api/methods.ts";
import type { Focuses } from "../agentmsg/focus.ts";
import type { Groups } from "./index.ts";

export function groupMethods(deps: { groups: () => Groups | undefined; focus: () => Focuses | undefined }): MethodTable {
  const get = (): Groups => {
    const g = deps.groups();
    if (!g) throw new RpcError("unavailable", "group chats are off on this node");
    return g;
  };
  const focus = (): Focuses => {
    const f = deps.focus();
    if (!f) throw new RpcError("unavailable", "focus is kept by the primary");
    return f;
  };
  return {
    "group.list": { handler: () => ({ groups: get().list() }) },
    "group.candidates": { handler: async () => ({ agents: await get().candidates() }) },
    "group.posts": {
      target: (p) => p.group,
      handler: (p) => get().posts(p.group, p.before, p.limit ?? 50),
    },
    "group.create": {
      handler: async (p) => ({ group: await get().create({ name: p.name, ...(p.purpose !== undefined ? { purpose: p.purpose } : {}), ...(p.notify ? { notify: p.notify } : {}), members: p.members }) }),
    },
    "group.update": {
      target: (p) => p.group,
      handler: (p) => ({ group: get().update(p.group, { ...(p.name !== undefined ? { name: p.name } : {}), ...(p.purpose !== undefined ? { purpose: p.purpose } : {}), ...(p.notify ? { notify: p.notify } : {}) }) }),
    },
    "group.post": {
      target: (p) => p.group,
      handler: async (p, ctx) => {
        // a file or a photo from a path reads one of the user's machines, as a transfer does: the terminal scope's
        const byPath = [...(p.photos ?? []), ...(p.files ?? [])].some((a) => "path" in a);
        if (byPath && ctx.client.access && !ctx.client.access.scopes.includes("terminal")) throw new RpcError("denied", "attaching a file from a machine needs access to its files (the terminal scope)");
        return { post: await get().postAsUser(p.group, p.text, p.replyTo, { ...(p.photos ? { photos: p.photos } : {}), ...(p.files ? { files: p.files } : {}) }) };
      },
    },
    "group.upload": {
      target: (p) => p.group,
      redact: (p) => ({ ...p, data: `${p.data.length} base64 characters` }),
      handler: (p) => get().upload({ group: p.group, ...(p.upload ? { upload: p.upload } : {}), name: p.name, size: p.size, at: p.at, data: p.data, ...(p.photo ? { photo: true } : {}) }),
    },
    "group.photo": {
      target: (p) => p.group,
      redactResult: (r) => ({ type: r.type, at: r.at, total: r.total, bytes: Math.floor((r.data.length * 3) / 4) }),
      handler: async (p) => {
        const r = await get().photo(p.group, p.photo, p.at ?? 0);
        return { type: r.type, data: r.base64, at: r.at, total: r.total };
      },
    },
    "group.file.save": {
      target: (p) => p.group,
      handler: async (p) => {
        const r = await get().save(p.group, p.post, p.file, p.to, { ...(p.relayOk ? { relayOk: true } : {}), by: { kind: "user" } });
        return { ...(r.transfer ? { transfer: r.transfer } : {}), ...(r.confirm ? { confirm: r.confirm } : {}) };
      },
    },
    "group.react": {
      target: (p) => p.group,
      handler: (p) => {
        get().react(p.group, p.post, p.on);
        return {};
      },
    },
    "group.read": {
      target: (p) => p.group,
      handler: (p) => {
        get().readAsUser(p.group, p.upTo);
        return {};
      },
    },
    "group.end": {
      target: (p) => p.group,
      handler: (p) => {
        get().end(p.group);
        return {};
      },
    },
    "group.delete": {
      target: (p) => p.group,
      handler: (p) => {
        get().delete(p.group);
        return {};
      },
    },
    "group.member.add": {
      target: (p) => p.group,
      handler: async (p) => ({ group: await get().addMembers(p.group, p.members) }),
    },
    "group.member.remove": {
      target: (p) => p.group,
      handler: (p) => ({ group: get().removeMember(p.group, p.member) }),
    },
    "group.member.set": {
      target: (p) => p.group,
      handler: (p) => ({ group: get().setNotify(p.group, p.member, p.notify) }),
    },
    "focus.list": { handler: () => ({ focus: deps.focus()?.list() ?? [] }) },
    "focus.end": {
      target: (p) => p.session,
      handler: (p) => {
        // answered at once; what was held follows the agent's catch-up notice in the background
        focus().release(p.session, "user");
        return {};
      },
    },
  };
}
