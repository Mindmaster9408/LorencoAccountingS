import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getUserFromRequest, unauthorized } from "@/lib/api-auth";
import { learnFromCorrection, ALLOCATION_CATEGORIES, syncConfirmedToAccountingEco } from "@/lib/bank-allocations";

export async function POST(request: NextRequest) {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return unauthorized();

    const { transactionId, description, correctCategory, feedback } = await request.json();

    // Validate inputs
    if (!description || !correctCategory) {
      return NextResponse.json(
        { error: "description and correctCategory are required" },
        { status: 400 }
      );
    }

    // Validate category exists
    const validCategory = ALLOCATION_CATEGORIES.find(c => c.code === correctCategory);
    if (!validCategory) {
      return NextResponse.json(
        { error: `Invalid category: ${correctCategory}` },
        { status: 400 }
      );
    }

    // Learn from the correction
    const { ruleId, isNew } = await learnFromCorrection(
      description,
      correctCategory,
      feedback || null,
      user.id
    );

    // Update transaction if provided
    if (transactionId) {
      try {
        await prisma.bankTransaction.update({
          where: { id: transactionId },
          data: {
            confirmedCategory: correctCategory,
            confirmedByUserId: user.id,
            feedback: feedback || null,
            processed: true,
          },
        });
      } catch (txError) {
        console.warn("Transaction update failed (may not exist):", txError);
      }

      // Push confirmed allocation to accounting-ecosystem staging pipeline.
      // Fire-and-forget — never blocks the user response.
      // Inactive unless both ECO_BASE_URL and ECO_SERVICE_TOKEN are set.
      const ecoBase = process.env.ECO_BASE_URL;
      if (ecoBase && process.env.ECO_SERVICE_TOKEN) {
        void syncConfirmedToAccountingEco(transactionId, ecoBase);
      }
    }

    return NextResponse.json({
      success: true,
      ruleId,
      isNewRule: isNew,
      category: correctCategory,
      categoryLabel: validCategory.label,
      message: isNew
        ? `Created new allocation rule for "${description.substring(0, 30)}..."`
        : `Reinforced existing rule for category ${validCategory.label}`,
    });
  } catch (error) {
    console.error("Allocation learn error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
