import type { Overview } from "../../stepsArtifact";
import type { AuthoringChunk } from "../digest";
import type { RawAuthoringResponse } from "../schema";

export interface AuthoringProviderInput {
  globalContext: string;
  chunk: AuthoringChunk;
  interimOverview: Overview | null;
}

export interface AuthoringProvider {
  invokeChunk(input: AuthoringProviderInput): Promise<RawAuthoringResponse>;
}
