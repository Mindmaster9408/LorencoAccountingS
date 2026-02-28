// Gauge rendering and needle updates
import { GAUGE_DEFINITIONS, GAUGE_ORDER, $, $all } from './config.js';
import { saveClient } from './storage.js';

export function renderCockpit(client, containerId = 'cockpit-grid') {
    const grid = document.getElementById(containerId);
    if(!grid) return;

    grid.innerHTML = '';

    GAUGE_ORDER.forEach(key => {
        const val = client.gauges[key] || 50;
        const def = GAUGE_DEFINITIONS[key];
        const el = document.createElement('div');
        el.className = 'gauge-card';
        el.innerHTML = `
            <div class="metallic-bezel" data-key="${key}">
                <div class="screw s1"></div>
                <div class="screw s2"></div>
                <div class="screw s3"></div>
                <div class="screw s4"></div>
                <div class="metallic-inner">
                    <div class="gauge-face" data-key="face-${key}">
                        ${createGaugeHTML(key, def.image)}
                    </div>
                </div>
            </div>
            <div class="gauge-label">${def.label}</div>
            <div class="gauge-sub">${def.sub}</div>
            <div class="gauge-controls">
                <input type="range" min="0" max="100" value="${val}" data-key="${key}" class="gauge-range" />
                <input type="number" min="0" max="100" value="${val}" data-key="${key}" class="gauge-number" />
            </div>
        `;
        grid.appendChild(el);
    });

    // Attach event listeners
    attachGaugeListeners(client);

    // Set initial needle positions
    GAUGE_ORDER.forEach(key => updateGaugeNeedle(key, client.gauges[key] || 50));
}

function createGaugeHTML(key, imageSrc) {
    // Add fuel pump SVG overlay for fuel gauge
    const fuelPumpOverlay = key === 'fuel' ? `
        <svg viewBox="0 0 200 200" class="fuel-pump-svg" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;">
            <g class="fuel-pump-icon" data-key="${key}" transform="translate(70, 95)">
                <!-- Fuel pump body -->
                <rect x="-10" y="-12.5" width="20" height="25" fill="#666666" stroke="#333333" stroke-width="0.5"/>
                <!-- Fuel pump nozzle -->
                <rect x="-12.5" y="-7.5" width="2.5" height="5" fill="#666666" stroke="#333333" stroke-width="0.3"/>
                <!-- Display screen -->
                <rect x="-6" y="-7.5" width="12" height="5" fill="#ffffff" stroke="#333333" stroke-width="0.3"/>
                <!-- Fuel droplet -->
                <ellipse cx="0" cy="5" rx="3" ry="6" fill="#666666"/>
                <polygon points="0,-4 -3,2 3,2" fill="#666666"/>
            </g>
        </svg>
    ` : '';

    // Add dynamic horizon overlay for horizon gauge
    const horizonOverlay = key === 'horizon' ? `
        <svg viewBox="0 0 400 400" class="horizon-svg" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;">
            <defs>
                <clipPath id="horizon-clip-${key}">
                    <circle cx="200" cy="200" r="130"/>
                </clipPath>
            </defs>
            <g clip-path="url(#horizon-clip-${key})">
                <!-- Sky (blue - fixed position with transparency) -->
                <rect x="0" y="60" width="400" height="140" fill="#0066cc" fill-opacity="0.7"/>
                <!-- Ground (brown - fixed position with transparency) -->
                <rect x="0" y="200" width="400" height="140" fill="#8b4513" fill-opacity="0.7"/>

                <!-- Moving horizon line and aircraft symbol group -->
                <g class="horizon-group" data-key="${key}">
                    <!-- Horizon line (moves with value) -->
                    <line x1="70" y1="200" x2="330" y2="200" stroke="#ffffff" stroke-width="3"/>
                    <!-- Center aircraft symbol (moves with value) -->
                    <line x1="160" y1="200" x2="180" y2="200" stroke="#ffff00" stroke-width="4"/>
                    <line x1="220" y1="200" x2="240" y2="200" stroke="#ffff00" stroke-width="4"/>
                    <circle cx="200" cy="200" r="8" fill="#ffff00" stroke="#ff8800" stroke-width="2"/>
                </g>
            </g>
        </svg>
    ` : '';

    // Needle overlay for all gauges except horizon
    const needleOverlay = key !== 'horizon' ? `
        <div class="gauge-needle-overlay">
            <svg viewBox="0 0 200 200" class="needle-svg">
                <defs>
                    <filter id="needle-shadow">
                        <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#000000" flood-opacity="0.8"/>
                    </filter>
                </defs>
                <g class="needle-group" data-key="${key}" transform="translate(100,100)">
                    <path d="M-2 10 L0 -70 L2 10 Z" fill="#dc2626" stroke="#991b1b" stroke-width="1" filter="url(#needle-shadow)"/>
                    <circle cx="0" cy="0" r="6" fill="#1f2937" stroke="#dc2626" stroke-width="2"/>
                </g>
            </svg>
        </div>
    ` : '';

    return `
        <div class="gauge-image-wrapper">
            <img src="${imageSrc}" class="gauge-bg-image" alt="${key} gauge" />
            ${fuelPumpOverlay}
            ${horizonOverlay}
            ${needleOverlay}
        </div>
    `;
}

function attachGaugeListeners(client) {
    // Range sliders
    $all('.gauge-range').forEach(range => {
        range.addEventListener('input', (e) => {
            const key = e.target.dataset.key;
            const value = Number(e.target.value);

            // Update number input
            const numberInput = document.querySelector(`.gauge-number[data-key="${key}"]`);
            if(numberInput) numberInput.value = value;

            // Update client data
            client.gauges[key] = value;

            // Update needle
            updateGaugeNeedle(key, value);
        });
    });

    // Number inputs
    $all('.gauge-number').forEach(input => {
        input.addEventListener('change', (e) => {
            const key = e.target.dataset.key;
            let value = Number(e.target.value);

            // Clamp value
            if(isNaN(value)) value = 0;
            value = Math.max(0, Math.min(100, value));
            e.target.value = value;

            // Update range slider
            const rangeInput = document.querySelector(`.gauge-range[data-key="${key}"]`);
            if(rangeInput) rangeInput.value = value;

            // Update client data
            client.gauges[key] = value;

            // Update needle
            updateGaugeNeedle(key, value);
        });
    });
}

export function updateGaugeNeedle(key, value) {
    // Handle horizon gauge separately (no needle, moves horizon group instead)
    if(key === 'horizon') {
        const horizonGroup = document.querySelector(`.horizon-group[data-key="${key}"]`);
        if(!horizonGroup) {
            console.warn(`Horizon group not found for key: ${key}`);
            return;
        }

        // Calculate offset: at value=50, offset=0; higher values move UP (negative), lower values move DOWN (positive)
        const offset = (50 - value) * 2.8;

        console.log(`Horizon update: value=${value}, offset=${offset}`);

        // Apply vertical translation
        horizonGroup.setAttribute('transform', `translate(0, ${offset})`);
        return;
    }

    // For all other gauges, look for needle group
    const needleGroup = document.querySelector(`.needle-group[data-key="${key}"]`);

    if(!needleGroup) {
        console.warn(`Needle group not found for key: ${key}`);
        return;
    }

    let rotation = 0;

    // Calculate rotation based on gauge type
    switch(key) {
        case 'fuel':
            // Fuel: 100=0° (up), 50=90° (right), 0=180° (down)
            rotation = 180 - (value / 100) * 180;

            // Change needle color based on fuel level
            const needlePath = needleGroup.querySelector('path');
            const needleCircle = needleGroup.querySelector('circle');

            if(needlePath && needleCircle) {
                let fillColor, strokeColor;

                if(value <= 33) {
                    // Red for 0-33
                    fillColor = '#dc2626';
                    strokeColor = '#991b1b';
                } else if(value <= 66) {
                    // Yellow for 34-66
                    fillColor = '#fbbf24';
                    strokeColor = '#d97706';
                } else {
                    // Green for 67-100
                    fillColor = '#22c55e';
                    strokeColor = '#16a34a';
                }

                needlePath.setAttribute('fill', fillColor);
                needlePath.setAttribute('stroke', strokeColor);
                needleCircle.setAttribute('stroke', strokeColor);

                // Also update fuel pump icon colors to match needle
                const fuelPumpIcon = document.querySelector(`.fuel-pump-icon[data-key="${key}"]`);
                if(fuelPumpIcon) {
                    const pumpRects = fuelPumpIcon.querySelectorAll('rect:not([fill="#ffffff"])');
                    const pumpEllipse = fuelPumpIcon.querySelector('ellipse');
                    const pumpPolygon = fuelPumpIcon.querySelector('polygon');

                    pumpRects.forEach(rect => rect.setAttribute('fill', fillColor));
                    if(pumpEllipse) pumpEllipse.setAttribute('fill', fillColor);
                    if(pumpPolygon) pumpPolygon.setAttribute('fill', fillColor);
                }
            }
            break;

        case 'compass':
        case 'nav':
            // Compass: 0-100 maps to 0-360 degrees (full circle)
            rotation = (value / 100) * 360;
            break;

        default:
            // Standard gauges: 0-100 maps to -120 to +120 degrees (240 degree arc)
            rotation = -120 + (value / 100) * 240;
            break;
    }

    // Apply rotation - keep the translate and add rotation
    needleGroup.setAttribute('transform', `translate(100,100) rotate(${rotation})`);
}

export async function saveGauges(client) {
    await saveClient(client);
    alert('Gauges saved successfully!');
}
