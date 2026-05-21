/* ================================================================
   cosmic-bg.js — Paytime Cosmic Particle Canvas
   Visual layer only — no payroll logic, no data, no auth
   Depends: #pt-bgCanvas injected by HTML (via Python injection script)
   ================================================================ */
(function ptCosmicCanvas() {
    'use strict';

    var canvas = document.getElementById('pt-bgCanvas');
    if (!canvas) return;

    var ctx = canvas.getContext('2d');
    var W, H;

    function resize() {
        W = canvas.width  = window.innerWidth;
        H = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    /* 55 particles — identical to Eco login/dashboard */
    var COUNT = 55;
    var particles = [];
    for (var i = 0; i < COUNT; i++) {
        particles.push({
            x:  Math.random() * 1400,
            y:  Math.random() * 900,
            r:  Math.random() * 1.4 + 0.4,
            dx: (Math.random() - 0.5) * 0.22,
            dy: (Math.random() - 0.5) * 0.22,
            o:  Math.random() * 0.4 + 0.08
        });
    }

    var rafId  = null;
    var active = true;

    function draw() {
        if (!active) return;
        ctx.clearRect(0, 0, W, H);
        for (var j = 0; j < particles.length; j++) {
            var p = particles[j];
            p.x += p.dx; p.y += p.dy;
            if (p.x < 0) p.x = W; else if (p.x > W) p.x = 0;
            if (p.y < 0) p.y = H; else if (p.y > H) p.y = 0;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(168,184,255,' + p.o + ')';
            ctx.fill();
        }
        rafId = requestAnimationFrame(draw);
    }

    /* Pause when tab is hidden — no wasted CPU */
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            active = false;
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        } else {
            active = true;
            draw();
        }
    });

    draw();
}());
