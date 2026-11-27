import { z } from "zod";
import { isAddress, isHex, type Address, type Hex } from "viem";

const address = z.string().refine(isAddress, "must be a 0x-prefixed address").transform((v) => v as Address);

const ConfigSchema = z
  .object({
    RPC_URL: z.url().default("https://rpc-test.qday.info"),
    CHAIN_ID: z.coerce.number().int().positive().default(44005),
    EXPLORER_URL: z.url().default("https://explorer-test.qday.info"),
    ESCROW_ADDRESS: address,
    MEDIATOR_ADDRESS: address,
    SESSION_KEY_PRIVATE_KEY: z
      .string()
      .refine((v) => isHex(v) && v.length === 66, "must be a 32-byte 0x-prefixed hex private key")
      .transform((v) => v as Hex)
      .optional(),
    MEDIATOR_MODE: z.enum(["claude", "rules"]).default("claude"),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
    PORT: z.coerce.number().int().default(8787),
    HOST: z.string().default("0.0.0.0"),
    EVIDENCE_DIR: z.string().default("../evidence-data"),
    POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),
    CORS_ORIGINS: z.string().default("http://localhost:3000"),
    MAX_EVIDENCE_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
    MAX_SUBMIT_ATTEMPTS: z.coerce.number().int().positive().default(5),
  })
  .transform((c) => ({ ...c, corsOrigins: c.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) }));

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid mediator configuration:\n${issues}`);
  }
  return parsed.data;
}
