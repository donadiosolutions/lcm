import {
  runNativeTranscriptBackfill,
  type NativeTranscriptBackfillOptions,
  type NativeTranscriptRepository,
} from "@donadiosolutions/lcm/storage/native-transcripts";

/**
 * Structural conformance for the published interface.
 *
 * Casting an empty object would satisfy the compiler no matter which members
 * the interface requires, so this file builds a complete implementation
 * instead. Adding a required member to NativeTranscriptRepository breaks this
 * file, which is the same break an external implementer would see, and is the
 * signal that the release needs a major bump.
 */
const externalImplementation: NativeTranscriptRepository = {
  ingestBatch: async () => {
    throw new Error("not implemented");
  },
  getById: async () => null,
  listByNativeSession: async () => [],
  listUnambiguousSourceLocators: async () => new Map<string, string>(),
  listBySource: async () => [],
  listByMessage: async () => [],
  getCheckpoint: async () => null,
};

const repository: NativeTranscriptRepository = externalImplementation;
const options = {} as NativeTranscriptBackfillOptions;
const run: Promise<unknown> = runNativeTranscriptBackfill(options);
void repository;
void run;
