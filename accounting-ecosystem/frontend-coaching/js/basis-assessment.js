// BASIS Assessment - Questions and Configuration

export const BASIS_SECTIONS = {
    BALANS: 'BALANS',
    AKSIE: 'AKSIE',
    SORG: 'SORG',
    INSIG: 'INSIG',
    STRUKTUUR: 'STRUKTUUR'
};

export const SECTION_LABELS = {
    BALANS: 'Balance',
    AKSIE: 'Action',
    SORG: 'Care',
    INSIG: 'Insight',
    STRUKTUUR: 'Structure'
};

export const BASIS_QUESTIONS = {
    BALANS: [
        { id: 1, text: 'I prefer environments that feel calm and emotionally safe.', reverse: false },
        { id: 2, text: 'I try to keep the peace when tension arises.', reverse: false },
        { id: 3, text: 'I feel uncomfortable when there is conflict around me.', reverse: false },
        { id: 4, text: 'I value harmony in relationships and groups.', reverse: false },
        { id: 5, text: 'I often think about how my actions affect the emotional atmosphere.', reverse: false },
        { id: 6, text: 'I feel more at ease when people around me are getting along.', reverse: false },
        { id: 7, text: 'I avoid unnecessary confrontation if I can.', reverse: false },
        { id: 8, text: 'I work best when things feel stable and settled.', reverse: false },
        { id: 9, text: 'I am comfortable addressing difficult conversations directly.', reverse: true },
        { id: 10, text: 'Conflict does not bother me; I prefer to face it openly.', reverse: true }
    ],
    AKSIE: [
        { id: 1, text: 'I feel energised when things move forward quickly.', reverse: false },
        { id: 2, text: 'I prefer taking action rather than overthinking.', reverse: false },
        { id: 3, text: 'I get frustrated when progress feels too slow.', reverse: false },
        { id: 4, text: 'I enjoy taking initiative.', reverse: false },
        { id: 5, text: 'I prefer making decisions and moving ahead.', reverse: false },
        { id: 6, text: 'I like opportunities that create momentum.', reverse: false },
        { id: 7, text: 'I enjoy challenges that push me to act.', reverse: false },
        { id: 8, text: 'I\'m motivated by measurable results.', reverse: false },
        { id: 9, text: 'I prefer to wait and observe before taking action.', reverse: true },
        { id: 10, text: 'I rarely make quick decisions; I prefer to think things through slowly.', reverse: true }
    ],
    SORG: [
        { id: 1, text: 'I care deeply about how other people feel.', reverse: false },
        { id: 2, text: 'I value kindness and empathy in relationships.', reverse: false },
        { id: 3, text: 'I feel fulfilled when I can support someone.', reverse: false },
        { id: 4, text: 'I notice when someone feels excluded or unseen.', reverse: false },
        { id: 5, text: 'I value integrity and doing the right thing.', reverse: false },
        { id: 6, text: 'I prefer meaningful relationships over superficial connections.', reverse: false },
        { id: 7, text: 'I often put people\'s well-being before outcomes.', reverse: false },
        { id: 8, text: 'I\'m motivated by work that feels meaningful.', reverse: false },
        { id: 9, text: 'I usually focus more on tasks than on people\'s emotions.', reverse: true },
        { id: 10, text: 'I sometimes struggle to notice what others are feeling.', reverse: true }
    ],
    INSIG: [
        { id: 1, text: 'I prefer understanding something deeply before acting.', reverse: false },
        { id: 2, text: 'I make decisions based on logic and evidence.', reverse: false },
        { id: 3, text: 'I enjoy analysing problems to find the best solution.', reverse: false },
        { id: 4, text: 'I value accuracy and clear reasoning.', reverse: false },
        { id: 5, text: 'I enjoy learning and expanding my understanding.', reverse: false },
        { id: 6, text: 'I prefer clarity over assumptions.', reverse: false },
        { id: 7, text: 'I like seeing the "big picture" and long-term implications.', reverse: false },
        { id: 8, text: 'I\'m comfortable working with complex ideas.', reverse: false },
        { id: 9, text: 'I prefer intuition over data when making decisions.', reverse: true },
        { id: 10, text: 'I don\'t always need to fully understand something before I start.', reverse: true }
    ],
    STRUKTUUR: [
        { id: 1, text: 'I feel more secure when there is a clear plan.', reverse: false },
        { id: 2, text: 'I prefer routines and predictable schedules.', reverse: false },
        { id: 3, text: 'I like organised systems and clear processes.', reverse: false },
        { id: 4, text: 'I value consistency and stability.', reverse: false },
        { id: 5, text: 'I feel uncomfortable when things are chaotic.', reverse: false },
        { id: 6, text: 'I prefer clear rules and expectations.', reverse: false },
        { id: 7, text: 'I plan ahead rather than leaving things to chance.', reverse: false },
        { id: 8, text: 'I get stressed by last-minute changes.', reverse: false },
        { id: 9, text: 'I thrive when my day is spontaneous and unstructured.', reverse: true },
        { id: 10, text: 'I enjoy it when plans change—it keeps things interesting.', reverse: true }
    ]
};

// Scoring functions
export function calculateAdjustedScore(rawAnswer, isReverse) {
    if (isReverse) {
        return 11 - rawAnswer;
    }
    return rawAnswer;
}

export function calculateSectionScore(answers, sectionKey) {
    const questions = BASIS_QUESTIONS[sectionKey];
    let total = 0;

    questions.forEach((question, index) => {
        const rawAnswer = answers[`${sectionKey}_${question.id}`] || 5; // Default to 5 if not answered
        const adjustedScore = calculateAdjustedScore(rawAnswer, question.reverse);
        total += adjustedScore;
    });

    return total;
}

export function calculateAllSectionScores(answers) {
    const scores = {};

    Object.keys(BASIS_QUESTIONS).forEach(sectionKey => {
        scores[sectionKey] = calculateSectionScore(answers, sectionKey);
    });

    return scores;
}

export function calculateBASISOrder(sectionScores) {
    // Convert scores object to array of [section, score] pairs
    const scoreArray = Object.entries(sectionScores);

    // Sort by score (highest to lowest)
    scoreArray.sort((a, b) => b[1] - a[1]);

    // Return array of section keys in order
    return scoreArray.map(pair => pair[0]);
}

export function getBASISResults(answers) {
    const sectionScores = calculateAllSectionScores(answers);
    const basisOrder = calculateBASISOrder(sectionScores);

    return {
        sectionScores,
        basisOrder,
        timestamp: new Date().toISOString()
    };
}
