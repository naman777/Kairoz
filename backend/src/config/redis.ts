import Redis from "ioredis";

const REDIS_HOST = process.env.REDIS_HOST || "";
const REDIS_PORT = process.env.REDIS_PORT
  ? parseInt(process.env.REDIS_PORT)
  : 17487;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || "";

const redisClient = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  username: "default",
  maxRetriesPerRequest: null, // Required for BullMQ
  lazyConnect: true,
  enableReadyCheck: false,
});

redisClient.on("error", (err: any) => console.log("Redis Client Error", err));

const connectRedis = async () => {
  try {
    await redisClient.ping();
    console.log("Connected to Redis");
  } catch (error) {
    console.error("Error connecting to Redis:", error);
  }
};

export { redisClient, connectRedis };
    