// Resumable-download spool: ciphertext chunks land on disk (plugin dir) as
// they arrive, so an interrupted large pull resumes by fetching only the
// missing chunks. Ciphertext is exactly what the server stores — spooling it
// locally adds no exposure. The whole-file plaintext buffer exists only
// during final recompose, shrinking the memory high-water window from the
// whole download to seconds.

/** Structural subset of Obsidian's DataAdapter — keeps this unit-testable. */
export interface SpoolFs {
  exists(normalizedPath: string): Promise<boolean>;
  mkdir(normalizedPath: string): Promise<void>;
  writeBinary(normalizedPath: string, data: ArrayBuffer): Promise<void>;
  readBinary(normalizedPath: string): Promise<ArrayBuffer>;
  rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
  list(normalizedPath: string): Promise<{ files: string[]; folders: string[] }>;
}

export class ChunkSpool {
  constructor(
    private fs: SpoolFs,
    private root: string,
  ) {}

  private dir(revisionId: string): string {
    return `${this.root}/${revisionId}`;
  }

  private partPath(revisionId: string, seq: number): string {
    return `${this.dir(revisionId)}/${String(seq).padStart(5, '0')}`;
  }

  async has(revisionId: string, seq: number): Promise<boolean> {
    return this.fs.exists(this.partPath(revisionId, seq));
  }

  async write(revisionId: string, seq: number, bytes: Uint8Array): Promise<void> {
    if (!(await this.fs.exists(this.root))) await this.fs.mkdir(this.root);
    if (!(await this.fs.exists(this.dir(revisionId)))) await this.fs.mkdir(this.dir(revisionId));
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    await this.fs.writeBinary(this.partPath(revisionId, seq), buffer);
  }

  async read(revisionId: string, seq: number): Promise<Uint8Array> {
    return new Uint8Array(await this.fs.readBinary(this.partPath(revisionId, seq)));
  }

  async clear(revisionId: string): Promise<void> {
    if (await this.fs.exists(this.dir(revisionId))) {
      await this.fs.rmdir(this.dir(revisionId), true);
    }
  }

  /** Drop spools for revisions that stopped being interesting (superseded heads). */
  async retainOnly(revisionIds: Set<string>): Promise<void> {
    if (!(await this.fs.exists(this.root))) return;
    const { folders } = await this.fs.list(this.root);
    for (const folder of folders) {
      const revisionId = folder.split('/').pop()!;
      if (!revisionIds.has(revisionId)) await this.fs.rmdir(folder, true);
    }
  }
}
