import {
  runNativeTranscriptBackfill,
  type NativeTranscriptBackfillOptions,
  type NativeTranscriptRepository,
} from "@donadiosolutions/lcm/storage/native-transcripts";

const repository = {} as NativeTranscriptRepository;
const options = {} as NativeTranscriptBackfillOptions;
const run: Promise<unknown> = runNativeTranscriptBackfill(options);
void repository;
void run;
