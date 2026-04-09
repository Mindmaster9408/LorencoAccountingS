#!/usr/bin/env python3
"""
Neon Circuit Logo Generator for Lorenco Ecosystem
Generates the master approved logo as PNG with exact glow, orbit, and premium visual depth
Run: python generate-neon-logo.py
Output: lorenco-logo-cropped.png (saves to current directory)
"""

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Circle, ConnectionPatch

plt.style.use('dark_background')
fig, ax = plt.subplots(figsize=(10, 10))
ax.set_xlim(-1.2, 1.2)
ax.set_ylim(-1.2, 1.2)
ax.axis('off')

# Background outer glow ring (multiple layers for glow)
for r in np.linspace(1.05, 1.25, 8):
    circle = Circle((0, 0), r, fill=False, linewidth=8, 
                    edgecolor='#4B0082', alpha=0.08)
    ax.add_patch(circle)

for r in np.linspace(1.05, 1.25, 5):
    circle = Circle((0, 0), r, fill=False, linewidth=4, 
                    edgecolor='#8A2BE2', alpha=0.12)
    ax.add_patch(circle)

# Main neon circle (purple-blue gradient feel)
circle = Circle((0, 0), 1.0, fill=False, linewidth=12, 
                edgecolor='#9370DB', alpha=0.9)
ax.add_patch(circle)

circle = Circle((0, 0), 1.0, fill=False, linewidth=6, 
                edgecolor='#00BFFF', alpha=0.7)
ax.add_patch(circle)

# Dotted outer rings
theta = np.linspace(0, 2*np.pi, 80)
for offset in [1.08, 1.15]:
    x = offset * np.cos(theta)
    y = offset * np.sin(theta)
    ax.scatter(x, y, c='#87CEEB', s=8, alpha=0.7)

# Define glowing nodes positions (L-shape + extra nodes)
nodes = np.array([
    (-0.6, -0.6),   # bottom left
    (-0.6,  0.4),   # top left
    ( 0.0,  0.4),   # top middle
    ( 0.0, -0.2),   # middle
    ( 0.7, -0.2),   # right middle
    ( 0.7, -0.7),   # bottom right
    ( 0.4, -0.9)    # extra bottom
])

# Connect nodes with thick neon lines (L shape + connections)
connections = [(0,1), (1,2), (2,3), (3,4), (4,5), (3,6)]

for i, j in connections:
    con = ConnectionPatch(nodes[i], nodes[j], "data", "data",
                          linewidth=8, color='#BA55D3', alpha=0.9)
    ax.add_patch(con)
    con = ConnectionPatch(nodes[i], nodes[j], "data", "data",
                          linewidth=4, color='#00FFFF', alpha=0.8)
    ax.add_patch(con)

# Extra glowing curve (bottom right)
t = np.linspace(0, np.pi/2, 50)
curve_x = 0.7 + 0.3 * np.cos(t + np.pi)
curve_y = -0.6 + 0.4 * np.sin(t + np.pi)
ax.plot(curve_x, curve_y, linewidth=10, color='#00BFFF', alpha=0.7)
ax.plot(curve_x, curve_y, linewidth=5, color='#87CEFA', alpha=0.9)

# Draw glowing nodes (multiple layers for strong neon glow)
for (x, y) in nodes:
    # Strong inner glow
    for r in [0.12, 0.09, 0.06]:
        c = Circle((x, y), r, color='#FFFFFF', alpha=0.15)
        ax.add_patch(c)
    # Bright center
    ax.scatter(x, y, c='#FFFFFF', s=180, zorder=10)
    ax.scatter(x, y, c='#00FFFF', s=80, zorder=11)
    ax.scatter(x, y, c='#FF69B4', s=30, zorder=12)   # pinkish highlight

# Extra scattered small dots for futuristic feel
np.random.seed(42)
for _ in range(40):
    ang = np.random.uniform(0, 2*np.pi)
    rad = np.random.uniform(0.7, 1.25)
    ax.scatter(rad*np.cos(ang), rad*np.sin(ang), 
               c='#ADD8E6', s=6, alpha=0.6)

plt.title("Neon Circuit Logo", color='white', fontsize=16, pad=20)
plt.tight_layout()

# Save as PNG
plt.savefig('lorenco-logo-cropped.png', dpi=150, bbox_inches='tight', 
            facecolor='#1a1a1a', edgecolor='none')
print("✓ Logo saved as: lorenco-logo-cropped.png")
plt.show()
