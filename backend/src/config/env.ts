import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "Database URL is required"),
  REDIS_HOST: z.string().default("redis://localhost:6379"),
  REDIS_PORT: z.string().default("6379").transform(Number),
  REDIS_PASSWORD: z.string().optional(),
  OPENAI_API_KEY: z.string().min(1, "OpenAI API key is required"),
  PINECONE_API_KEY: z.string().min(1, "Pinecone API key is required"),
  PINECONE_INDEX_NAME: z.string().default("kairoz-incidents"),
  PORT: z.string().default("3000").transform(Number),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export const env = envSchema.parse(process.env);
