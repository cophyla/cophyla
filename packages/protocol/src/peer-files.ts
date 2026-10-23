// Files between two people's Cophylas: what a teammate's link (`team.file.*`) and a
// connection's (`conn.file.*`) carry when an agent of one side sends a file or a folder to an
// agent of the other, and when a member of a group chat saves a file posted on the other side.
// The receiving side pulls, as a transfer between the user's own machines does: it lists what
// the file holds (`*.file.tree`, a page at a time) and reads it a piece at a time
// (`*.file.read`), each piece what a relayed frame takes once base64'd and sealed. The sending
// side answers only for a file it let that side read: one its agent sent there (`pfile_`), or
// one attached to a post in a group both are in (`gfile_`, with the group), read from where it
// is then, on whichever of its own machines.

import { z } from "zod";
import { GroupFile, GroupPhoto, GroupPhotoType, HarnessKind, TransferReason } from "./entities.ts";
import { ConnectionId, GroupFileId, GroupId, GroupPhotoId, PeerFileId, TeammateId, Timestamp } from "./ids.ts";

/** The bytes one read carries: base64'd and sealed, it fits a relayed frame (4 MiB) with room to spare. */
export const FILE_PIECE_BYTES = 1.5 * 1024 * 1024;
/** A piece as base64. */
export const FILE_PIECE_BASE64 = (FILE_PIECE_BYTES / 3) * 4;

/** One entry of what `files.tree` lists: a folder, or a file with its size and when it last changed. */
export const TreeEntry = z.object({
  rel: z.string().max(4096),
  dir: z.literal(true).optional(),
  size: z.number().int().nonnegative().optional(),
  mtimeMs: z.number().int().nonnegative().optional(),
});
export type TreeEntry = z.infer<typeof TreeEntry>;

/** A file the other side let this side read: one sent to this side's agent, or one posted in a group both are in. */
export const PeerFileRef = z.object({ file: z.union([PeerFileId, GroupFileId]), group: GroupId.optional() });
export type PeerFileRef = z.infer<typeof PeerFileRef>;

/** A page of what a file holds, as `files.tree` gives it: a file is one entry (`rel` ""), a folder its folders and files. */
export const FileTreePage = z.object({
  kind: z.enum(["file", "folder"]),
  name: z.string().min(1).max(255),
  entries: z.array(TreeEntry).max(5000),
  total: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  next: z.number().int().positive().optional(),
});
export type FileTreePage = z.infer<typeof FileTreePage>;

/** A piece of a file: its bytes from `at`, base64, and the file as it is now, so a reader can tell it changed. */
export const FilePiece = z.object({
  data: z.string().max(FILE_PIECE_BASE64),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().int().nonnegative(),
});
export type FilePiece = z.infer<typeof FilePiece>;

/**
 * An agent of the sending side sent `to`, an agent of this side by its name here, a file or a
 * folder, which this side pulls into the Downloads folder of that agent's machine and tells it
 * where it landed. `sending`: it is being pulled; `asked`: it is big, and this side's user is
 * asked first.
 */
export const PeerFileSend = z.object({
  file: PeerFileId,
  to: z.string().min(1).max(120),
  name: z.string().min(1).max(255),
  kind: z.enum(["file", "folder"]),
  total: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  reason: TransferReason.optional(),
  from: z.object({ name: z.string().min(1).max(120), harness: HarnessKind.optional() }),
  sentAt: Timestamp,
});
export type PeerFileSend = z.infer<typeof PeerFileSend>;
export const PeerFileSendResult = z.object({ status: z.enum(["sending", "asked"]) });

/** How a file this side was sent ended there: landed, or not and why, in words for the agent that sent it. */
export const PeerFileDone = z.object({ file: PeerFileId, ok: z.boolean(), why: z.string().max(300).optional() });
export type PeerFileDone = z.infer<typeof PeerFileDone>;

/** The link requests for files, as a teammate's link and a connection's both carry them, under their own prefixes. */
export const peerFileRequests = {
  send: { params: PeerFileSend, result: PeerFileSendResult },
  tree: { params: PeerFileRef.extend({ from: z.number().int().nonnegative().optional() }), result: FileTreePage },
  read: { params: PeerFileRef.extend({ rel: z.string().max(4096).optional(), at: z.number().int().nonnegative() }), result: FilePiece },
  done: { params: PeerFileDone, result: z.object({}) },
} as const;

/** A photo of a group's post, a piece at a time from `at`: its bytes, base64, and how many there are. */
export const PhotoPiece = z.object({
  type: GroupPhotoType,
  data: z.string().max(FILE_PIECE_BASE64),
  at: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});
export type PhotoPiece = z.infer<typeof PhotoPiece>;

export const GroupPhotoRef = z.object({ group: GroupId, photo: GroupPhotoId, at: z.number().int().nonnegative().optional() });

/**
 * Where a transfer from another person comes from, as this user's primary starts it on the
 * machine it goes to: the teammate or the connection it comes through, the file, and who sent
 * it. That machine reads it through the primary (the node link's `peer.file.*`), which alone
 * holds the link to the other person's Cophyla.
 */
export const PeerSource = z.object({
  kind: z.enum(["teammate", "connection"]),
  id: z.union([TeammateId, ConnectionId]),
  file: z.union([PeerFileId, GroupFileId]),
  group: GroupId.optional(),
  user: z.string().min(1).max(64),
  agent: z.string().min(1).max(200).optional(),
});
export type PeerSource = z.infer<typeof PeerSource>;
