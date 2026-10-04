/**
 * Environment variables the configured evaluator backend needs. Read from the environment, not
 * from lib/ai, because importing lib/ai already resolves (and validates) the evaluator.
 */
export function evaluatorEnv(): string[] {
  return (process.env.EVALUATOR_BACKEND?.trim() || "typesafe") === "typesafe"
    ? ["TYPESAFE_AI_API_KEY"]
    : [];
}

/** Reads a required environment variable, failing fast with a clear message. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. Set it in your environment or .env file.`,
    );
  }
  return value;
}
