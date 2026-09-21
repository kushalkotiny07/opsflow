/**
 * Data Sources API
 * GET /api/data-sources - List all data sources
 * POST /api/data-sources - Register a new data source
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth/session";
import { DataSourceType, UserRole } from "@prisma/client";
import prisma from "@/lib/db/client";
import { RegisterDataSourceRequest, RegisterDataSourceResponse } from "@/types/multi-source";
import {
  isValidSourceId,
  isValidTableReference,
  isValidSqlIdentifier,
  isValidPollingInterval,
  isValidBackfillDays,
  isReadOnlyQueryTemplate,
  POLLING_INTERVAL_MIN,
  POLLING_INTERVAL_MAX,
  validationError,
} from "@/lib/validation/data-sources";
import { newRequestId, logAndBuildErrorBody } from "@/lib/observability/request-id";
import { introspectColumnValues, tableNameFromReference } from "@/lib/data-sources/column-enums";

const VALID_POLLING_TYPES: DataSourceType[] = ["DATABASE", "WEBHOOK", "API"];

/**
 * GET /api/data-sources
 * List all data sources
 */
export async function GET(req: NextRequest) {
  const requestId = newRequestId();

  try {
    const user = await getSessionFromRequest(req);

    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN", requestId },
        { status: 403 }
      );
    }

    const dataSources = await prisma.dataSource.findMany({
      select: {
        id: true,
        sourceId: true,
        displayName: true,
        description: true,
        tableReference: true,
        primaryKeyField: true,
        typeFieldName: true,
        statusFieldName: true,
        typeFieldEnumValues: true,
        statusFieldEnumValues: true,
        queryTemplate: true,
        metadataFieldMapping: true,
        analyticsConfig: true,
        isActive: true,
        pollingIntervalMinutes: true,
        pollingType: true,
        syncStrategy: true,
        // syncEndpoint must be in the response — PUT writes to it; without
        // round-tripping it the edit drawer would silently blank the field.
        syncEndpoint: true,
        backfillEnabled: true,
        backfillDays: true,
        backfillCompleted: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json({
      dataSources,
      count: dataSources.length,
    });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "DataSourcesAPI.GET",
        code: "FETCH_ERROR",
        userMessage: "Failed to fetch data sources",
        error,
      }),
      { status: 500 }
    );
  }
}

/**
 * POST /api/data-sources
 * Register a new data source
 */
export async function POST(req: NextRequest) {
  const requestId = newRequestId();

  try {
    const user = await getSessionFromRequest(req);

    if (!user || user.role !== UserRole.OPS_HEAD) {
      return NextResponse.json(
        { error: "Unauthorized", code: "FORBIDDEN", requestId },
        { status: 403 }
      );
    }

    const body = (await req.json()) as RegisterDataSourceRequest;

    // ─── Required-field check ─────────────────────────────────────────────
    const requiredFields = [
      "sourceId", "displayName", "tableReference",
      "primaryKeyField", "typeFieldName", "statusFieldName", "queryTemplate",
    ];
    const missingFields = requiredFields.filter((f) => !body[f as keyof RegisterDataSourceRequest]);
    if (missingFields.length > 0) {
      return NextResponse.json(
        {
          error: "Missing required fields",
          code: "VALIDATION_ERROR",
          requestId,
          details: { missingFields },
        },
        { status: 400 }
      );
    }

    // ─── Identifier shape validation ──────────────────────────────────────
    if (!isValidSourceId(body.sourceId)) {
      return NextResponse.json({ ...validationError("sourceId", "must be a valid identifier (letters, digits, underscore; ≤63 chars; cannot start with digit)"), requestId }, { status: 400 });
    }
    if (!isValidTableReference(body.tableReference)) {
      return NextResponse.json({ ...validationError("tableReference", "must be a valid table reference like 'Order', 'public.Order', or 'public.\"Order\"'"), requestId }, { status: 400 });
    }
    for (const [field, value] of [
      ["primaryKeyField", body.primaryKeyField || "id"],
      ["typeFieldName", body.typeFieldName],
      ["statusFieldName", body.statusFieldName],
    ] as const) {
      if (!isValidSqlIdentifier(value)) {
        return NextResponse.json({ ...validationError(field, "must be a valid SQL column identifier"), requestId }, { status: 400 });
      }
    }

    // ─── Query template — read-only SELECT/WITH only ──────────────────────
    if (!isReadOnlyQueryTemplate(body.queryTemplate)) {
      return NextResponse.json({ ...validationError("queryTemplate", "must be a single read-only query starting with SELECT or WITH; INSERT/UPDATE/DELETE/DDL not allowed"), requestId }, { status: 400 });
    }

    // ─── Polling interval bounds ──────────────────────────────────────────
    // Use ?? (not ||) so a legitimate 0 from the body still triggers the
    // explicit-validation path rather than silently falling back to default.
    const pollingIntervalMinutes = body.pollingIntervalMinutes ?? 5;
    if (!isValidPollingInterval(pollingIntervalMinutes)) {
      return NextResponse.json({ ...validationError("pollingIntervalMinutes", `must be an integer between ${POLLING_INTERVAL_MIN} and ${POLLING_INTERVAL_MAX}`), requestId }, { status: 400 });
    }

    // ─── Polling type ─────────────────────────────────────────────────────
    // Bug fix: previously hard-coded to "DATABASE" regardless of body input.
    const pollingType = (body.pollingType ?? "DATABASE") as DataSourceType;
    if (!VALID_POLLING_TYPES.includes(pollingType)) {
      return NextResponse.json({ ...validationError("pollingType", `must be one of: ${VALID_POLLING_TYPES.join(", ")}`), requestId }, { status: 400 });
    }

    // ─── Backfill flags ───────────────────────────────────────────────────
    // Use ?? so `false` and `0` are honoured rather than defaulted away.
    const backfillEnabled = body.backfillEnabled ?? false;
    if (typeof backfillEnabled !== "boolean") {
      return NextResponse.json({ ...validationError("backfillEnabled", "must be a boolean"), requestId }, { status: 400 });
    }
    const backfillDays = body.backfillDays ?? 7;
    if (!isValidBackfillDays(backfillDays)) {
      return NextResponse.json({ ...validationError("backfillDays", "must be an integer between 0 and 365"), requestId }, { status: 400 });
    }

    // ─── Uniqueness ───────────────────────────────────────────────────────
    const existingSource = await prisma.dataSource.findUnique({
      where: { sourceId: body.sourceId },
    });

    if (existingSource) {
      return NextResponse.json(
        {
          error: "Data source already exists",
          code: "CONFLICT",
          requestId,
          details: { sourceId: body.sourceId },
        },
        { status: 409 }
      );
    }

    // ─── Capture the type/status column enums at registration ─────────────
    // Introspect the live LABSTACK columns so rule validation has the source's
    // real value set from day one. Best-effort: a null result (replica down,
    // text column) leaves the column empty and the rule validator falls back to
    // live introspection at save time. Never blocks registration.
    const table = tableNameFromReference(body.tableReference);
    const [typeFieldEnumValues, statusFieldEnumValues] = await Promise.all([
      introspectColumnValues(table, body.typeFieldName),
      introspectColumnValues(table, body.statusFieldName),
    ]);

    // ─── Create ───────────────────────────────────────────────────────────
    const dataSource = await prisma.dataSource.create({
      data: {
        sourceId: body.sourceId,
        displayName: body.displayName,
        description: body.description,
        tableReference: body.tableReference,
        primaryKeyField: body.primaryKeyField || "id",
        typeFieldName: body.typeFieldName,
        statusFieldName: body.statusFieldName,
        typeFieldEnumValues: typeFieldEnumValues.length > 0 ? typeFieldEnumValues : undefined,
        statusFieldEnumValues: statusFieldEnumValues.length > 0 ? statusFieldEnumValues : undefined,
        queryTemplate: body.queryTemplate,
        metadataFieldMapping: body.metadataFieldMapping,
        analyticsConfig: body.analyticsConfig ?? undefined,
        pollingIntervalMinutes,
        pollingType,
        backfillEnabled,
        backfillDays,
        createdById: user.id,
        isActive: true,
      },
    });

    const response: RegisterDataSourceResponse = {
      id: dataSource.id,
      sourceId: dataSource.sourceId,
      displayName: dataSource.displayName,
      validationResult: {
        ok: true,
        message: "Data source registered successfully",
      },
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      logAndBuildErrorBody({
        requestId,
        scope: "DataSourcesAPI.POST",
        code: "CREATION_ERROR",
        userMessage: "Failed to register data source",
        error,
      }),
      { status: 500 }
    );
  }
}
