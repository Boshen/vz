import { defineHandler } from "void";
import { api } from "../../../src/server/api";

const handler = defineHandler((c) => api.fetch(c.req.raw, { context: c }, c.executionCtx));
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
