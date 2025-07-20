import { Pinecone } from "@pinecone-database/pinecone";

const PINECONE_API_KEY = process.env.PINECONE_API_KEY || "";

const pc = new Pinecone({
  apiKey: PINECONE_API_KEY,
});

export const pinecone = pc;
