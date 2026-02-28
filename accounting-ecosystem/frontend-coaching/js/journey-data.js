// Journey data structure - The Neuro-Coach Method
export const JOURNEY_PHASES = {
    phase1: {
        name: 'Phase 1',
        color: '#3b82f6',
        steps: [1, 2, 3, 4, 5, 6]
    },
    phase2: {
        name: 'Phase 2',
        color: '#8b5cf6',
        steps: [7, 8, 9, 10, 11, 12]
    },
    phase3: {
        name: 'Phase 3',
        color: '#ec4899',
        steps: [13, 14, 15, 16, 17]
    }
};

export const JOURNEY_STEPS = {
    1: {
        title: '4 Quadrant Exercise',
        icon: '➕',
        phase: 'phase1',
        description: 'Discover what drives and challenges you',
        whyMatters: [
            'Creates clarity on current situation',
            'Identifies pain points and dreams',
            'Establishes coaching foundation'
        ]
    },
    2: {
        title: 'Present-Gap-Future',
        icon: '🎯',
        phase: 'phase1',
        description: 'Map the gap between where you are and where you want to be',
        whyMatters: [
            'Defines current reality clearly',
            'Identifies the gap to bridge',
            'Creates motivating vision of future'
        ]
    },
    3: {
        title: 'Flight Plan',
        icon: '✈️',
        phase: 'phase1',
        description: 'Create your action plan and milestones',
        whyMatters: [
            'Breaks down big goals into steps',
            'Creates accountability structure',
            'Provides clear next actions'
        ]
    },
    4: {
        title: 'Deep Dive',
        icon: '🔍',
        phase: 'phase1',
        description: 'Explore underlying patterns and root causes',
        whyMatters: [
            'Uncovers hidden beliefs and patterns',
            'Identifies core challenges',
            'Creates deeper self-awareness'
        ]
    },
    5: {
        title: 'Ecochart',
        icon: '🌐',
        phase: 'phase1',
        description: 'Map your ecosystem of relationships - what you give and take',
        whyMatters: [
            'Visualizes your relationship ecosystem',
            'Identifies give/take balance',
            'Reveals areas of depletion or abundance'
        ]
    },
    6: {
        title: 'Assessments',
        icon: '📊',
        phase: 'phase1',
        description: 'Complete comprehensive assessments and baseline evaluations',
        whyMatters: [
            'Provides data-driven insights',
            'Establishes baseline metrics',
            'Identifies strengths and development areas'
        ]
    },
    7: {
        title: 'The Cockpit',
        icon: '🎛️',
        phase: 'phase2',
        description: 'Your personal flight control center and metrics dashboard',
        whyMatters: [
            'Visualizes all key metrics in one place',
            'Tracks progress over time',
            'Enables data-driven decisions'
        ]
    },
    8: {
        title: 'Personal Driving Dynamics (PDD)',
        icon: '⚙️',
        phase: 'phase2',
        description: 'Understand your core motivators and behavioral drivers',
        whyMatters: [
            'Reveals what truly motivates you',
            'Identifies your driving forces',
            'Aligns actions with intrinsic motivation'
        ]
    },
    9: {
        title: 'Psychoeducation',
        icon: '🧠',
        phase: 'phase2',
        description: 'Learn the neuroscience behind behavior and change',
        whyMatters: [
            'Understand how your brain works',
            'Learn principles of lasting change',
            'Gain tools for self-regulation'
        ]
    },
    10: {
        title: 'MLNP',
        icon: '🧬',
        phase: 'phase2',
        description: 'Multi-Level Neuro Processing - rewire neural pathways',
        whyMatters: [
            'Creates new neural pathways',
            'Breaks old limiting patterns',
            'Builds sustainable new habits'
        ]
    },
    11: {
        title: 'Reassess',
        icon: '🔄',
        phase: 'phase2',
        description: 'Re-evaluate progress and adjust course',
        whyMatters: [
            'Measures tangible progress',
            'Validates effectiveness of interventions',
            'Informs next steps'
        ]
    },
    12: {
        title: 'Revisit',
        icon: '↩️',
        phase: 'phase2',
        description: 'Review and refine previous work',
        whyMatters: [
            'Reinforces learning and integration',
            'Deepens understanding',
            'Ensures sustainable change'
        ]
    },
    13: {
        title: 'The Dream-Spot',
        icon: '💭',
        phase: 'phase3',
        description: 'Discover the intersection of passion, skill, and purpose',
        whyMatters: [
            'Identifies your unique sweet spot',
            'Aligns passion with capability',
            'Creates compelling vision'
        ]
    },
    14: {
        title: 'Values & Beliefs',
        icon: '⚖️',
        phase: 'phase3',
        description: 'Clarify core values and empowering beliefs',
        whyMatters: [
            'Defines what truly matters to you',
            'Identifies limiting vs. empowering beliefs',
            'Creates alignment with authentic self'
        ]
    },
    15: {
        title: 'Success Traits',
        icon: '⛰️',
        phase: 'phase3',
        description: 'Identify and develop traits for success',
        whyMatters: [
            'Recognizes existing strengths',
            'Identifies traits to develop',
            'Creates success blueprint'
        ]
    },
    16: {
        title: 'Curiosity, Passion, Purpose',
        icon: '🎯',
        phase: 'phase3',
        description: 'Integrate the three drivers of fulfillment',
        whyMatters: [
            'Connects what fascinates you',
            'Aligns with what energizes you',
            'Links to what matters most'
        ]
    },
    17: {
        title: 'Creativity and Flow',
        icon: '⚡',
        phase: 'phase3',
        description: 'Unlock creative potential and enter flow states',
        whyMatters: [
            'Accesses peak performance states',
            'Unlocks creative problem-solving',
            'Creates sustainable excellence'
        ]
    }
};

// Helper function to get journey progress
export function getJourneyProgress(client) {
    if (!client.journeyProgress) {
        return {
            currentStep: 1,
            completedSteps: [],
            percentComplete: 0,
            currentPhase: 'phase1'
        };
    }

    const completedSteps = client.journeyProgress.completedSteps || [];
    const currentStep = client.journeyProgress.currentStep || 1;
    const percentComplete = Math.round((completedSteps.length / 17) * 100);
    const currentPhase = JOURNEY_STEPS[currentStep].phase;

    return {
        currentStep,
        completedSteps,
        percentComplete,
        currentPhase
    };
}

// Helper function to get phase progress
export function getPhaseProgress(client, phase) {
    const { completedSteps } = getJourneyProgress(client);
    const phaseSteps = JOURNEY_PHASES[phase].steps;
    const completedInPhase = phaseSteps.filter(step => completedSteps.includes(step));
    return Math.round((completedInPhase.length / phaseSteps.length) * 100);
}

// Initialize journey progress for a client
export function initializeJourneyProgress(client) {
    if (!client.journeyProgress) {
        client.journeyProgress = {
            currentStep: 1,
            completedSteps: [],
            stepNotes: {},
            stepCompletionDates: {}
        };
    }
    return client;
}
