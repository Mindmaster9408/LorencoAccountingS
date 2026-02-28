// Configuration and Constants
export const STORAGE_KEY = 'coaching_app_v1';

export const JOURNEY_STEPS = [
    {id:'kwadrant', name:'4 Quadrant Exercise', icon:'🟦'},
    {id:'present-gap-future', name:'Present-Gap-Future', icon:'🌉'},
    {id:'flight-plan', name:'Flight Plan', icon:'🗺️'},
    {id:'deep-dive', name:'Deep Dive', icon:'🤿'},
    {id:'assessments', name:'Assessments & Ecochart', icon:'💻'},
    {id:'dashboard-step', name:'The Dashboard', icon:'📊'},
    {id:'psycho-edu', name:'Psycho Education', icon:'🧠'},
    {id:'mlnp', name:'MLNP (Gesigkaarte)', icon:'🧩'},
    {id:'reassessment', name:'Reassessment', icon:'🔁'},
    {id:'revisit', name:'Revisit', icon:'↩️'},
    {id:'dream-spot', name:'The Dream-Spot', icon:'❤️'},
    {id:'values-beliefs', name:'Values & Beliefs', icon:'⚠️'},
    {id:'success-traits', name:'Success Traits', icon:'🧗'},
    {id:'curiosity', name:'Curiosity/Passion/Purpose', icon:'⭕'},
    {id:'creativity-flow', name:'Creativity & Flow', icon:'💡'}
];

export const GAUGE_DEFINITIONS = {
    fuel: {label:'Fuel / Energy', sub:'Emotional Functioning', image:'images/fuel-gauge.png'},
    horizon: {label:'Artificial Horizon', sub:'Flow State Qualities', image:'images/horizon-gauge.png'},
    thrust: {label:'Thrust', sub:'Power', image:'images/thrust-gauge.png'},
    engine: {label:'Engine Condition', sub:'Self-Perception', image:'images/engine-gauge.png'},
    compass: {label:'Compass / Dream', sub:'Direction', image:'images/compass-gauge.png'},
    positive: {label:'Positive', sub:'Emotion', image:'images/positive-gauge.png'},
    weight: {label:'Weight', sub:'Balance', image:'images/weight-gauge.png'},
    nav: {label:'Navigation', sub:'Direction', image:'images/compass-gauge.png'},
    negative: {label:'Negative', sub:'Stress', image:'images/negative-gauge.png'}
};

export const GAUGE_ORDER = ['fuel','horizon','thrust','engine','compass','positive','weight','nav','negative'];

// Helper functions
export function $(sel) {
    return document.querySelector(sel);
}

export function $all(sel) {
    return Array.from(document.querySelectorAll(sel));
}

export function escapeHtml(s) {
    return (s||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;');
}