import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type MessageFile = {
  id: string;
  path: string;
  raw: Buffer;
};

export type WriteMessageInput = {
  id: string;
  raw: string | Buffer;
};

export class MessageRepository {
  private readonly rootDir: string;

  constructor(rootDir = path.join(os.homedir(), ".inbox-one")) {
    this.rootDir = path.resolve(rootDir);
  }

  getRootDir(): string {
    return this.rootDir;
  }

  async read(id: string): Promise<MessageFile> {
    const filePath = this.getMessagePath(id);
    const raw = await readFile(filePath);

    return {
      id: this.normalizeId(id),
      path: filePath,
      raw,
    };
  }

  async write(message: WriteMessageInput): Promise<MessageFile> {
    await mkdir(this.rootDir, { recursive: true });

    const id = this.normalizeId(message.id);
    const filePath = this.getMessagePath(id);
    const raw = Buffer.isBuffer(message.raw) ? message.raw : Buffer.from(message.raw, "utf8");

    await writeFile(filePath, raw);

    return {
      id,
      path: filePath,
      raw,
    };
  }

  async list(): Promise<string[]> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true });

      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".eml"))
        .map((entry) => entry.name.slice(0, -".eml".length))
        .sort((a, b) => a.localeCompare(b));
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private getMessagePath(id: string): string {
    const normalizedId = this.normalizeId(id);
    const filePath = path.resolve(this.rootDir, `${normalizedId}.eml`);
    const relativePath = path.relative(this.rootDir, filePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Message id "${id}" resolves outside the message repository.`);
    }

    return filePath;
  }

  private normalizeId(id: string): string {
    const normalizedId = id.endsWith(".eml") ? id.slice(0, -".eml".length) : id;

    if (!normalizedId) {
      throw new Error("Message id is required.");
    }

    if (normalizedId.includes("/") || normalizedId.includes("\\")) {
      throw new Error(`Message id "${id}" must not contain path separators.`);
    }

    return normalizedId;
  }
}
