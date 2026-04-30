import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import {
  authSessionSchema,
  currentUserProfileSchema,
  updateCurrentUserProfileSchema,
} from "@paperclipai/shared";
import { unauthorized } from "../errors.js";
import { expressHandler } from "../http/express-adapter.js";
import type { Handler } from "../http/types.js";
import type { StorageService } from "../storage/types.js";

async function loadCurrentUserProfile(db: Db, userId: string) {
  const user = await db
    .select({
      id: authUsers.id,
      email: authUsers.email,
      name: authUsers.name,
      image: authUsers.image,
    })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);

  if (!user) {
    throw unauthorized("Signed-in user not found");
  }

  return currentUserProfileSchema.parse({
    id: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    image: user.image ?? null,
  });
}

function buildHandlers(db: Db) {
  // server/src/routes/auth.ts:40
  const getSession: Handler = async (ctx) => {
    if (ctx.actor?.type !== "board" || !ctx.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const user = await loadCurrentUserProfile(db, ctx.actor.userId);
    return Response.json(authSessionSchema.parse({
      session: {
        id: `paperclip:${ctx.actor.source}:${ctx.actor.userId}`,
        userId: ctx.actor.userId,
      },
      user,
    }));
  };

  // server/src/routes/auth.ts:55
  const getProfile: Handler = async (ctx) => {
    if (ctx.actor?.type !== "board" || !ctx.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    return Response.json(await loadCurrentUserProfile(db, ctx.actor.userId));
  };

  // server/src/routes/auth.ts:63
  const patchProfile: Handler = async (ctx) => {
    if (ctx.actor?.type !== "board" || !ctx.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const body = await ctx.json();
    const patch = updateCurrentUserProfileSchema.parse(body);
    const now = new Date();

    const updated = await db
      .update(authUsers)
      .set({
        name: patch.name,
        ...(patch.image !== undefined ? { image: patch.image } : {}),
        updatedAt: now,
      })
      .where(eq(authUsers.id, ctx.actor.userId))
      .returning({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        image: authUsers.image,
      })
      .then((rows) => rows[0] ?? null);

    if (!updated) {
      throw unauthorized("Signed-in user not found");
    }

    return Response.json(currentUserProfileSchema.parse({
      id: updated.id,
      email: updated.email ?? null,
      name: updated.name ?? null,
      image: updated.image ?? null,
    }));
  };

  return { getSession, getProfile, patchProfile };
}

export function authRoutes(db: Db) {
  const router = Router();
  const { getSession, getProfile, patchProfile } = buildHandlers(db);

  // None of these handlers touch storage; supply a sentinel so expressHandler's
  // AdapterDeps type is satisfied without widening the public signature.
  const storageSentinel = new Proxy({} as StorageService, {
    get(_target, prop) {
      throw new Error(`auth handler unexpectedly accessed storage.${String(prop)}`);
    },
  });
  const deps = { db, storage: storageSentinel };

  router.get("/get-session", expressHandler(getSession, deps));
  router.get("/profile", expressHandler(getProfile, deps));
  router.patch("/profile", expressHandler(patchProfile, deps));

  return router;
}
