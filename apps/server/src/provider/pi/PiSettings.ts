import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PiSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("pi"))),
});

export type PiSettings = typeof PiSettings.Type;
