import { Buffer } from "node:buffer";
import { decodePrepareHarnessSetup } from "../../src/protocol/codec.ts";

const [encoded, workerId, rawGeneration] = process.argv.slice(2);
if (!encoded || !workerId || !rawGeneration)
  throw new Error("encoded payload, Worker ID, and generation are required");

const generation = Number(rawGeneration);
if (!Number.isInteger(generation) || generation <= 0)
  throw new Error("generation must be a positive integer");

const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
const decoded = decodePrepareHarnessSetup(payload, workerId, generation);
process.stdout.write(`${JSON.stringify(decoded)}\n`);
