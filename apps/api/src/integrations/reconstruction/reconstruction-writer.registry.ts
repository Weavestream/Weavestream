import { Injectable } from '@nestjs/common';
import type { IntegrationTargetKind } from '@weavestream/shared';
import type {
  ReconstructionInput,
  ReconstructionWriter,
} from './reconstruction-target.js';

@Injectable()
export class ReconstructionWriterRegistry {
  private readonly writers = new Map<IntegrationTargetKind, ReconstructionWriter<never>>();

  constructor(writers: ReadonlyArray<ReconstructionWriter<ReconstructionInput>> = []) {
    for (const writer of writers) this.register(writer);
  }

  register<T extends ReconstructionInput>(writer: ReconstructionWriter<T>): void {
    if (this.writers.has(writer.targetKind)) {
      throw new Error(`Reconstruction writer already registered for ${writer.targetKind}.`);
    }
    this.writers.set(writer.targetKind, writer as ReconstructionWriter<never>);
  }

  get<T extends ReconstructionInput>(targetKind: T['targetKind']): ReconstructionWriter<T> {
    const writer = this.writers.get(targetKind);
    if (!writer) throw new Error(`No reconstruction writer registered for ${targetKind}.`);
    return writer as ReconstructionWriter<T>;
  }
}
