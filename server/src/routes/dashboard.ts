import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";
import { assertCompanyAccess } from "./authz.js";
import type { Handler } from "../http/types.js";
import { expressHandler } from "../http/express-adapter.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  const getDashboard: Handler = async (ctx) => {
    const companyId = ctx.param("companyId");
    assertCompanyAccess(ctx, companyId!);
    const summary = await svc.summary(companyId!);
    return Response.json(summary);
  };

  router.get(
    "/companies/:companyId/dashboard",
    expressHandler(getDashboard, { db, storage: null as never }),
  );

  return router;
}
