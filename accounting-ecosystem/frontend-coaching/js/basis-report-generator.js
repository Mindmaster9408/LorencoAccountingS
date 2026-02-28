// BASIS Report Generator - Creates professional multi-page reports

import { BASIS_DEFINITIONS, BASIS_COLORS, POSITION_MEANINGS, REPORT_CONTENT } from './basis-report-data.js';
import { SECTION_LABELS } from './basis-assessment.js';

export function generateBASISReport(client, language = 'en') {
    if (!client.basisResults) {
        throw new Error('Client has not completed BASIS assessment');
    }

    const { basisOrder, sectionScores } = client.basisResults;
    const code = basisOrder.join(' ');
    const date = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    if (language === 'af') {
        return generateAfrikaansReport(client, basisOrder, sectionScores, code, date);
    }

    return generateEnglishReport(client, basisOrder, sectionScores, code, date);
}

function generateEnglishReport(client, basisOrder, sectionScores, code, date) {
    const primary = BASIS_DEFINITIONS[basisOrder[0]];

    let report = '';

    // PAGE 1: COVER PAGE
    report += generateCoverPage(client.name, code, date);

    // PAGE 2: COPYRIGHT
    report += generateCopyrightPage(code);

    // PAGE 3: INTRODUCTION
    report += generateIntroductionPage(code);

    // PAGE 4: CONTENTS
    report += generateContentsPage();

    // PAGE 5: YOUR BASIS CODE
    report += generateBASISCodePage(basisOrder, sectionScores);

    // PAGE 6: PRIMARY PERSONALITY TYPE
    report += generatePrimaryTypePage(primary, basisOrder);

    // PAGES 7-8: FULL PERSONALITY PROFILE
    report += generateFullProfilePages(basisOrder, sectionScores);

    // PAGES 9-10: STRENGTHS
    report += generateStrengthsPages(basisOrder);

    // PAGES 11-12: TRIGGERS & TRIPWIRES
    report += generateTriggersTripwiresPages(basisOrder);

    // PAGES 13-14: COMMUNICATION TIPS
    report += generateCommunicationTipsPages();

    // PAGES 15-16: FAMILY CHALLENGE
    report += generateFamilyChallengePage();

    // PAGES 17-18: BUSINESS CHALLENGE
    report += generateBusinessChallengePage();

    // PAGE 19: ABOUT
    report += generateAboutPage();

    // PAGE 20: PRODUCTS & SERVICES
    report += generateProductsPage();

    return report;
}

function generateCoverPage(clientName, code, date) {
    return `
# Your Full BASIS Report
## B.A.S.I.S. Personality Report

**Client:** ${clientName}

**Your BASIS Code:**
<div style="font-size: 48px; font-weight: bold; letter-spacing: 8px; margin: 32px 0;">
${formatCodeWithColors(code)}
</div>

**Purpose:** Help you understand how you make decisions, communicate with others, and unlock your potential.

**The Infinity Legacy**
*Neuro-Coaching for Transformation*

**Report Date:** ${date}

---

<div class="page-break"></div>
`;
}

function generateCopyrightPage(code) {
    return `
# ${code} Profile Report ©2025

## Copyright and Disclaimer

**The Infinity Legacy – All rights reserved.**

No part of this publication may be reproduced, distributed, or transmitted in any form or by any means, including photocopying, recording, or other electronic or mechanical methods, without the prior written permission of The Infinity Legacy.

This report is confidential and intended solely for the individual named on the cover page.

**B.A.S.I.S.** is a trademark of The Infinity Legacy.

**Created by:** Ruan van Loggerenberg

**Contact:** infinitylegacy.co.za

---

<div class="page-break"></div>
`;
}

function generateIntroductionPage(code) {
    return `
# Introduction

## Your BASIS Profile is ${code}

This comprehensive personality profile is aimed at helping you better know what makes you tick, especially when you make important decisions.

With the **B.A.S.I.S. Methodology**, you can pinpoint a person's personality profile—their BASIS code—and use that information to communicate more effectively in any situation.

### ${REPORT_CONTENT.intro.title}

${REPORT_CONTENT.intro.text}

**B.A.S.I.S. stands for:**

- **I** = **Insig** (Logic & Insight) – Knowledge Values
- **A** = **Aksie** (Drive & Momentum) – Action Values
- **S** = **Struktuur** (Structure & Order) – Blueprint Values
- **B** = **Balans** (Emotional Harmony & Safety) – Nurturing Values
- **S** = **Sorg** (Connection & Care) – Nurturing Values

All humans use these five forces in decision-making, but in unique priority orders. Your order reveals your personality blueprint.

**Learn more:** infinitylegacy.co.za

---

<div class="page-break"></div>
`;
}

function generateContentsPage() {
    return `
# Contents

| Page | Section |
|------|---------|
| 04 | **YOUR BASIS CODE** – How to interpret your BASIS code |
| 05 | **YOUR PRIMARY PERSONALITY TYPE** – What is your mindset? |
| 06 | **PERSONALITY PROFILE** – Your full BASIS profile in detail |
| 08 | **STRENGTHS** – How to interact with others more effectively |
| 10 | **TRIGGERS & TRIPWIRES** – What lights you up and turns you off |
| 12 | **COMMUNICATION TIPS** – How to communicate with other personality types |
| 14 | **THE INFINITY CHALLENGE – FAMILY** – Improve your personal life |
| 16 | **THE INFINITY CHALLENGE – BUSINESS** – Improve your professional life |
| 18 | **ABOUT THE INFINITY LEGACY** – Who we are |
| 20 | **PRODUCTS & SERVICES** – How to go deeper |

---

<div class="page-break"></div>
`;
}

function generateBASISCodePage(basisOrder, sectionScores) {
    const code = basisOrder.join(' ');
    const primary = BASIS_DEFINITIONS[basisOrder[0]];

    return `
# Your BASIS Code Is ${code}

## Understanding Your Unique Profile

People with **${code}** as their BASIS code are primarily **${primary.tagline.toLowerCase()}** individuals who lead with **${primary.name}** (${primary.fullName}).

Your BASIS code is ranked from highest to lowest score based on your assessment responses:

${basisOrder.map((type, index) => {
    const def = BASIS_DEFINITIONS[type];
    const position = POSITION_MEANINGS[index + 1];
    return `
### ${index + 1}. ${def.name} – ${position.shortDesc}
**Score:** ${sectionScores[type]}/100 | **${position.title}**

${position.description}
`;
}).join('\n')}

---

<div class="page-break"></div>
`;
}

function generatePrimaryTypePage(primary, basisOrder) {
    return `
# Your Primary B.A.S.I.S. Personality Type

## ${primary.fullName}

Your primary type is **${primary.name}**, which means you are driven by **${primary.tagline.toLowerCase()}**.

### Core Values

${primary.values.map(v => `- ${v}`).join('\n')}

### Key Characteristics

${primary.characteristics.map(c => `- ${c}`).join('\n')}

### What This Means for You

${primary.meaning}

As a **${primary.name}-primary** individual, you naturally gravitate toward decisions and environments that align with these values. Understanding this helps you make better choices and communicate your needs more effectively.

---

<div class="page-break"></div>
`;
}

function generateFullProfilePages(basisOrder, sectionScores) {
    return `
# Personality Profile
## Your Complete BASIS Breakdown

${basisOrder.map((type, index) => {
    const def = BASIS_DEFINITIONS[type];
    const position = POSITION_MEANINGS[index + 1];
    return `
### Position ${index + 1}: ${def.name} (${def.fullName})
**Score:** ${sectionScores[type]}/100 | **Role:** ${position.title}

**Core Values:** ${def.values.slice(0, 6).join(', ')}

**Description:** ${def.meaning}

**How This Shows Up in Your Life:**

${def.characteristics.slice(0, 4).map(c => `- ${c}`).join('\n')}

---
`;
}).join('\n')}

<div class="page-break"></div>
`;
}

function generateStrengthsPages(basisOrder) {
    return `
# Strengths of Your Personality Type

## Knowing Your Strengths Creates Synergy

Understanding your unique strengths—and those of others—creates powerful synergy in teams, relationships, and personal growth.

${basisOrder.slice(0, 3).map((type, index) => {
    const def = BASIS_DEFINITIONS[type];
    const position = POSITION_MEANINGS[index + 1];
    return `
### ${index + 1}. ${def.name} Strengths (${position.shortDesc})

${def.strengths.map(s => `- ${s}`).join('\n')}
`;
}).join('\n')}

### How to Leverage Your Strengths

- **Lead with your primary (${BASIS_DEFINITIONS[basisOrder[0]].name})** in high-stakes situations
- **Support with your secondary (${BASIS_DEFINITIONS[basisOrder[1]].name})** to add depth and nuance
- **Develop your lower preferences** to become more versatile and balanced

---

<div class="page-break"></div>
`;
}

function generateTriggersTripwiresPages(basisOrder) {
    const primary = BASIS_DEFINITIONS[basisOrder[0]];
    const secondary = BASIS_DEFINITIONS[basisOrder[1]];

    return `
# Triggers & Tripwires

## What Lights You Up and What Turns You Off

Understanding your triggers and tripwires helps you create environments where you thrive and avoid situations that drain you.

## ✅ Your Triggers (What You Love)

### ${primary.name} Triggers

${primary.triggers.map(t => `- ${t}`).join('\n')}

### ${secondary.name} Triggers

${secondary.triggers.map(t => `- ${t}`).join('\n')}

---

## ❌ Your Tripwires (What Drains You)

### ${primary.name} Tripwires

${primary.tripwires.map(t => `- ${t}`).join('\n')}

### ${secondary.name} Tripwires

${secondary.tripwires.map(t => `- ${t}`).join('\n')}

---

<div class="page-break"></div>
`;
}

function generateCommunicationTipsPages() {
    return `
# Communication Tips

## How to Communicate with Each Personality Type

Effective communication means speaking to others in their "language." Here's how to communicate with each BASIS type:

${Object.values(BASIS_DEFINITIONS).map(def => `
### Communicating with ${def.name} (${def.fullName})

${def.communicationTips.map(tip => `- ${tip}`).join('\n')}
`).join('\n')}

---

<div class="page-break"></div>
`;
}

function generateFamilyChallengePage() {
    return `
# ${REPORT_CONTENT.familyChallenge.title}

## ${REPORT_CONTENT.familyChallenge.subtitle}

${REPORT_CONTENT.familyChallenge.text}

### ${REPORT_CONTENT.familyChallenge.story.title}

${REPORT_CONTENT.familyChallenge.story.text}

### Take the Infinity Challenge

Share your BASIS report with your family members and encourage them to take the assessment. Then:

1. **Compare your codes** and discuss how they show up in daily life
2. **Identify communication gaps** where different values clash
3. **Create "translation strategies"** to bridge differences
4. **Celebrate diversity** and leverage each person's strengths

**Result:** Deeper understanding, less conflict, stronger bonds.

---

<div class="page-break"></div>
`;
}

function generateBusinessChallengePage() {
    return `
# ${REPORT_CONTENT.businessChallenge.title}

## ${REPORT_CONTENT.businessChallenge.subtitle}

${REPORT_CONTENT.businessChallenge.text}

### ${REPORT_CONTENT.businessChallenge.story.title}

${REPORT_CONTENT.businessChallenge.story.text}

### Take the Infinity Challenge

Use BASIS in your professional life:

1. **Identify prospects' codes** early in conversations
2. **Tailor your pitch** to their values and decision-making style
3. **Build teams** with complementary BASIS profiles
4. **Manage effectively** by understanding what motivates each person
5. **Resolve conflicts** by recognizing different value systems

**Result:** Higher sales, better teamwork, increased productivity.

---

<div class="page-break"></div>
`;
}

function generateAboutPage() {
    return `
# ${REPORT_CONTENT.about.title}

${REPORT_CONTENT.about.text}

## ${REPORT_CONTENT.about.mission}

### Our Approach

The B.A.S.I.S. system is built on:

- **Neuro-Coach Method** – Brain-based coaching for lasting change
- **Multi-Level Neuro-Processing (MLNP)** – Integrating cognitive thinking, body awareness, emotional processing, and goal realignment
- **Systemic Coaching** – Combining financial, business, life, and neuro-development

### Our Founder

**Ruan van Loggerenberg** is a leading neuro-coach and creator of the B.A.S.I.S. Methodology. With years of experience in transformation coaching, Ruan has helped thousands of individuals and organizations unlock their potential.

**Connect with us:** infinitylegacy.co.za

---

<div class="page-break"></div>
`;
}

function generateProductsPage() {
    return `
# ${REPORT_CONTENT.products.title}

## Take Your Transformation Further

${REPORT_CONTENT.products.items.map(item => `
### ${item.name}

${item.description}
`).join('\n')}

### Ready to Go Deeper?

Visit **${REPORT_CONTENT.products.website}** to:

- Access the Infinity Vault training platform
- Get certified as a BASIS coach
- Use BASIS AI for advanced personality analysis
- Book personal neuro-coaching sessions
- Join our community of transformation leaders

---

## BASIS Report Generated Successfully

**© 2025 The Infinity Legacy. All Rights Reserved.**

Contact: infinitylegacy.co.za

---
`;
}

function formatCodeWithColors(code) {
    const letters = code.split(' ');
    return letters.map(letter => {
        const color = BASIS_COLORS[letter];
        return `<span style="color: ${color};">${letter}</span>`;
    }).join(' ');
}

// Afrikaans version will be added separately
function generateAfrikaansReport(client, basisOrder, sectionScores, code, date) {
    // TODO: Implement full Afrikaans translation
    return `
# Afrikaans Report Coming Soon

Die Afrikaanse weergawe van hierdie verslag is binnekort beskikbaar.

Jou BASIS-kode: ${code}
`;
}
