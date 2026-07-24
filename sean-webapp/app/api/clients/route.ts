// app/api/clients/route.ts
// Client/Company Management API for multi-tenant support

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, unauthorized } from "@/lib/api-auth";
import prisma from "@/lib/db";

// GET - List all clients with company profiles
export async function GET(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const { searchParams } = new URL(request.url);
    const includeStats = searchParams.get("stats") === "true";
    const includeIndustry = searchParams.get("industry") === "true";

    const clients = await prisma.client.findMany({
      orderBy: { name: "asc" },
      include: {
        industry: includeIndustry,
        _count: includeStats
          ? {
              select: {
                allocationRules: true,
                bankTransactions: true,
                customCategories: true,
              },
            }
          : undefined,
      },
    });

    return NextResponse.json(clients);
  } catch (error) {
    console.error("List clients error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST - Create new client with company profile
export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const body = await request.json();
    const {
      name,
      code,
      description,
      defaultMinConfidence,
      autoAllocateEnabled,
      // Company profile fields
      industryId,
      businessType,
      vatRegistered,
      vatNumber,
      companyRegNumber,
      businessDescription,
      mainProducts,
      mainServices,
      mainExpenseTypes,
      mainIncomeTypes,
      financialYearEnd,
      contactPerson,
      contactEmail,
      contactPhone,
      dataIsolationLevel,
      ecoCompanyId,
    } = body;

    if (!name || !code) {
      return NextResponse.json(
        { error: "Name and code are required" },
        { status: 400 }
      );
    }

    // Check if code already exists
    const existing = await prisma.client.findUnique({
      where: { code: code.toUpperCase() },
    });

    if (existing) {
      return NextResponse.json(
        { error: "Client code already exists" },
        { status: 400 }
      );
    }

    const client = await prisma.client.create({
      data: {
        name,
        code: code.toUpperCase(),
        description,
        defaultMinConfidence: defaultMinConfidence || 0.8,
        autoAllocateEnabled: autoAllocateEnabled !== false,
        // Company profile
        industryId,
        businessType,
        vatRegistered: vatRegistered || false,
        vatNumber,
        companyRegNumber,
        businessDescription,
        mainProducts: mainProducts ? JSON.stringify(mainProducts) : undefined,
        mainServices: mainServices ? JSON.stringify(mainServices) : undefined,
        mainExpenseTypes: mainExpenseTypes ? JSON.stringify(mainExpenseTypes) : undefined,
        mainIncomeTypes: mainIncomeTypes ? JSON.stringify(mainIncomeTypes) : undefined,
        financialYearEnd,
        contactPerson,
        contactEmail,
        contactPhone,
        dataIsolationLevel: dataIsolationLevel || "STRICT",
        ecoCompanyId: ecoCompanyId || undefined,
      },
      include: { industry: true },
    });

    // Log creation
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actionType: "CLIENT_CREATE",
        entityType: "Client",
        entityId: client.id,
        detailsJson: JSON.stringify({ name, code: client.code, industryId }),
      },
    });

    return NextResponse.json(client);
  } catch (error) {
    console.error("Create client error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH - Update client with company profile
export async function PATCH(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const body = await request.json();
    const {
      id,
      name,
      description,
      isActive,
      defaultMinConfidence,
      autoAllocateEnabled,
      // Company profile fields
      industryId,
      businessType,
      vatRegistered,
      vatNumber,
      companyRegNumber,
      businessDescription,
      mainProducts,
      mainServices,
      mainExpenseTypes,
      mainIncomeTypes,
      financialYearEnd,
      contactPerson,
      contactEmail,
      contactPhone,
      dataIsolationLevel,
      ecoCompanyId,
    } = body;

    if (!id) {
      return NextResponse.json({ error: "Client ID required" }, { status: 400 });
    }

    // Build update data dynamically
    const updateData: Record<string, unknown> = {};

    // Basic fields
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (defaultMinConfidence !== undefined) updateData.defaultMinConfidence = defaultMinConfidence;
    if (autoAllocateEnabled !== undefined) updateData.autoAllocateEnabled = autoAllocateEnabled;
    // Empty string clears the link (stored as null, since ecoCompanyId is @unique
    // and Prisma/SQLite treat "" as a real value that would collide across clients)
    if (ecoCompanyId !== undefined) updateData.ecoCompanyId = ecoCompanyId === "" ? null : ecoCompanyId;

    // Company profile fields
    if (industryId !== undefined) updateData.industryId = industryId;
    if (businessType !== undefined) updateData.businessType = businessType;
    if (vatRegistered !== undefined) updateData.vatRegistered = vatRegistered;
    if (vatNumber !== undefined) updateData.vatNumber = vatNumber;
    if (companyRegNumber !== undefined) updateData.companyRegNumber = companyRegNumber;
    if (businessDescription !== undefined) updateData.businessDescription = businessDescription;
    if (mainProducts !== undefined) updateData.mainProducts = JSON.stringify(mainProducts);
    if (mainServices !== undefined) updateData.mainServices = JSON.stringify(mainServices);
    if (mainExpenseTypes !== undefined) updateData.mainExpenseTypes = JSON.stringify(mainExpenseTypes);
    if (mainIncomeTypes !== undefined) updateData.mainIncomeTypes = JSON.stringify(mainIncomeTypes);
    if (financialYearEnd !== undefined) updateData.financialYearEnd = financialYearEnd;
    if (contactPerson !== undefined) updateData.contactPerson = contactPerson;
    if (contactEmail !== undefined) updateData.contactEmail = contactEmail;
    if (contactPhone !== undefined) updateData.contactPhone = contactPhone;
    if (dataIsolationLevel !== undefined) updateData.dataIsolationLevel = dataIsolationLevel;

    const client = await prisma.client.update({
      where: { id },
      data: updateData,
      include: { industry: true },
    });

    // Log update
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actionType: "CLIENT_UPDATE",
        entityType: "Client",
        entityId: client.id,
        detailsJson: JSON.stringify({ updatedFields: Object.keys(updateData) }),
      },
    });

    return NextResponse.json(client);
  } catch (error) {
    console.error("Update client error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE - Delete client
export async function DELETE(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Client ID required" }, { status: 400 });
    }

    // Check if client has transactions
    const transactionCount = await prisma.bankTransaction.count({
      where: { clientId: id },
    });

    if (transactionCount > 0) {
      return NextResponse.json(
        {
          error: "Cannot delete client with transactions",
          transactionCount,
          message: "Deactivate the client instead, or delete transactions first",
        },
        { status: 400 }
      );
    }

    await prisma.client.delete({ where: { id } });

    return NextResponse.json({ success: true, message: "Client deleted" });
  } catch (error) {
    console.error("Delete client error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
