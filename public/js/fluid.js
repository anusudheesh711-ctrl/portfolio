/* ==========================================================================
   WebGL fluid background (vanilla, no dependencies)
   A small stable-fluids solver (advection, vorticity, pressure projection)
   inspired by the classic GPU Navier-Stokes technique.

   Tuning lives in CONFIG and PALETTE below.
   Falls back to the static CSS gradient (.no-fluid) when the visitor
   prefers reduced motion or WebGL is unavailable.
   ========================================================================== */
(function () {
  "use strict";

  var root = document.documentElement;
  var canvas = document.getElementById("fluid");
  var motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  function useStatic() { root.classList.add("no-fluid"); }
  if (!canvas || motionQuery.matches) { useStatic(); return; }

  /* ---------- Config ---------- */
  var isSmall = Math.min(window.innerWidth, window.innerHeight) < 720;
  var CONFIG = {
    SIM_RESOLUTION: isSmall ? 64 : 128,     // velocity grid (lower = faster)
    DYE_RESOLUTION: isSmall ? 384 : 1024,   // color detail
    PIXEL_RATIO: Math.min(window.devicePixelRatio || 1, isSmall ? 1.25 : 1.75),
    DENSITY_DISSIPATION: 0.8,   // how fast color fades
    VELOCITY_DISSIPATION: 0.35, // how fast motion settles
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: isSmall ? 12 : 20,
    CURL: 24,                   // swirliness
    SPLAT_RADIUS: 0.1,         // brush size
    SPLAT_FORCE: 2000,
    COLOR_INTENSITY: 0.4,      // keep low so text stays readable
    POINTER_COLOR_BOOST: 1.4,
    IDLE_SPLAT_MS: 3200,         // gentle ambient splats when nobody is interacting
    
  };

  // Accent palette (matches --violet, --teal, --pink in styles.css), RGB 0..1
  var PALETTE = [
    [0.545, 0.490, 1.000],
    [0.180, 0.902, 0.839],
    [1.000, 0.416, 0.659]
  ];

  /* ---------- WebGL context + capability detection ---------- */
  var ctx = getContext(canvas);
  if (!ctx) { useStatic(); return; }
  var gl = ctx.gl, ext = ctx.ext;

  function getContext(c) {
    var params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, powerPreference: "low-power" };
    var g = c.getContext("webgl2", params);
    var isWebGL2 = !!g;
    if (!g) g = c.getContext("webgl", params) || c.getContext("experimental-webgl", params);
    if (!g) return null;

    var halfFloat, supportLinear;
    if (isWebGL2) {
      g.getExtension("EXT_color_buffer_float");
      supportLinear = g.getExtension("OES_texture_float_linear");
    } else {
      halfFloat = g.getExtension("OES_texture_half_float");
      supportLinear = g.getExtension("OES_texture_half_float_linear");
    }
    var type = isWebGL2 ? g.HALF_FLOAT : halfFloat && halfFloat.HALF_FLOAT_OES;
    if (!type) return null;

    var rgba, rg, r;
    if (isWebGL2) {
      rgba = supportedFormat(g, g.RGBA16F, g.RGBA, type);
      rg = supportedFormat(g, g.RG16F, g.RG, type);
      r = supportedFormat(g, g.R16F, g.RED, type);
    } else {
      rgba = rg = r = supportedFormat(g, g.RGBA, g.RGBA, type);
    }
    if (!rgba || !rg || !r) return null;

    return { gl: g, ext: { rgba: rgba, rg: rg, r: r, type: type, linear: !!supportLinear } };
  }

  function supportedFormat(g, internalFormat, format, type) {
    if (!canRenderTo(g, internalFormat, format, type)) {
      if (internalFormat === g.R16F) return supportedFormat(g, g.RG16F, g.RG, type);
      if (internalFormat === g.RG16F) return supportedFormat(g, g.RGBA16F, g.RGBA, type);
      return null;
    }
    return { internalFormat: internalFormat, format: format };
  }

  function canRenderTo(g, internalFormat, format, type) {
    var tex = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, tex);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.texImage2D(g.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    var fbo = g.createFramebuffer();
    g.bindFramebuffer(g.FRAMEBUFFER, fbo);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
    var ok = g.checkFramebufferStatus(g.FRAMEBUFFER) === g.FRAMEBUFFER_COMPLETE;
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.deleteFramebuffer(fbo);
    g.deleteTexture(tex);
    return ok;
  }

  /* ---------- Shaders ---------- */
  var baseVertex = [
    "precision highp float;",
    "attribute vec2 aPosition;",
    "varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;",
    "uniform vec2 texelSize;",
    "void main () {",
    "  vUv = aPosition * 0.5 + 0.5;",
    "  vL = vUv - vec2(texelSize.x, 0.0); vR = vUv + vec2(texelSize.x, 0.0);",
    "  vT = vUv + vec2(0.0, texelSize.y); vB = vUv - vec2(0.0, texelSize.y);",
    "  gl_Position = vec4(aPosition, 0.0, 1.0);",
    "}"
  ].join("\n");

  var HEAD = "precision highp float; precision highp sampler2D;\n" +
    "varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;\n";

  var shaders = {
    copy: HEAD + "uniform sampler2D uTexture; void main () { gl_FragColor = texture2D(uTexture, vUv); }",

    clear: HEAD + "uniform sampler2D uTexture; uniform float value;" +
      "void main () { gl_FragColor = value * texture2D(uTexture, vUv); }",

    // Output premultiplied color so the canvas blends over the dark page
    display: HEAD + "uniform sampler2D uTexture;" +
      "void main () { vec3 c = min(texture2D(uTexture, vUv).rgb, vec3(1.0));" +
      "  float a = max(c.r, max(c.g, c.b)); gl_FragColor = vec4(c, a); }",

    splat: HEAD + "uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius;" +
      "void main () { vec2 p = vUv - point.xy; p.x *= aspectRatio;" +
      "  vec3 s = exp(-dot(p, p) / radius) * color; vec3 base = texture2D(uTarget, vUv).xyz;" +
      "  gl_FragColor = vec4(base + s, 1.0); }",

    advection: HEAD + "uniform sampler2D uVelocity; uniform sampler2D uSource; uniform vec2 texelSize; uniform vec2 dyeTexelSize; uniform float dt; uniform float dissipation;\n" +
      "vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {" +
      "  vec2 st = uv / tsize - 0.5; vec2 iuv = floor(st); vec2 fuv = fract(st);" +
      "  vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize); vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);" +
      "  vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize); vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);" +
      "  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y); }\n" +
      "void main () {\n" +
      "#ifdef MANUAL_FILTERING\n" +
      "  vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize; vec4 result = bilerp(uSource, coord, dyeTexelSize);\n" +
      "#else\n" +
      "  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize; vec4 result = texture2D(uSource, coord);\n" +
      "#endif\n" +
      "  float decay = 1.0 + dissipation * dt; gl_FragColor = result / decay; }",

    divergence: HEAD + "uniform sampler2D uVelocity;" +
      "void main () { float L = texture2D(uVelocity, vL).x; float R = texture2D(uVelocity, vR).x;" +
      "  float T = texture2D(uVelocity, vT).y; float B = texture2D(uVelocity, vB).y; vec2 C = texture2D(uVelocity, vUv).xy;" +
      "  if (vL.x < 0.0) { L = -C.x; } if (vR.x > 1.0) { R = -C.x; } if (vT.y > 1.0) { T = -C.y; } if (vB.y < 0.0) { B = -C.y; }" +
      "  gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0); }",

    curl: HEAD + "uniform sampler2D uVelocity;" +
      "void main () { float L = texture2D(uVelocity, vL).y; float R = texture2D(uVelocity, vR).y;" +
      "  float T = texture2D(uVelocity, vT).x; float B = texture2D(uVelocity, vB).x;" +
      "  gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0); }",

    vorticity: HEAD + "uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;" +
      "void main () { float L = texture2D(uCurl, vL).x; float R = texture2D(uCurl, vR).x;" +
      "  float T = texture2D(uCurl, vT).x; float B = texture2D(uCurl, vB).x; float C = texture2D(uCurl, vUv).x;" +
      "  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L)); force /= length(force) + 0.0001;" +
      "  force *= curl * C; force.y *= -1.0; vec2 vel = texture2D(uVelocity, vUv).xy + force * dt;" +
      "  vel = min(max(vel, -1000.0), 1000.0); gl_FragColor = vec4(vel, 0.0, 1.0); }",

    pressure: HEAD + "uniform sampler2D uPressure; uniform sampler2D uDivergence;" +
      "void main () { float L = texture2D(uPressure, vL).x; float R = texture2D(uPressure, vR).x;" +
      "  float T = texture2D(uPressure, vT).x; float B = texture2D(uPressure, vB).x; float div = texture2D(uDivergence, vUv).x;" +
      "  gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0); }",

    gradientSubtract: HEAD + "uniform sampler2D uPressure; uniform sampler2D uVelocity;" +
      "void main () { float L = texture2D(uPressure, vL).x; float R = texture2D(uPressure, vR).x;" +
      "  float T = texture2D(uPressure, vT).x; float B = texture2D(uPressure, vB).x;" +
      "  vec2 vel = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B); gl_FragColor = vec4(vel, 0.0, 1.0); }"
  };

  function compile(type, source, defines) {
    var s = gl.createShader(type);
    gl.shaderSource(s, (defines || "") + source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  var vertexShader;
  function createProgram(fragSource, defines) {
    var p = gl.createProgram();
    gl.attachShader(p, vertexShader);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSource, defines));
    gl.bindAttribLocation(p, 0, "aPosition");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    var uniforms = {};
    var count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < count; i++) {
      var name = gl.getActiveUniform(p, i).name;
      uniforms[name] = gl.getUniformLocation(p, name);
    }
    return { program: p, u: uniforms, bind: function () { gl.useProgram(p); } };
  }

  var P = {};
  try {
    vertexShader = compile(gl.VERTEX_SHADER, baseVertex);
    Object.keys(shaders).forEach(function (k) {
      P[k] = createProgram(shaders[k], k === "advection" && !ext.linear ? "#define MANUAL_FILTERING\n" : "");
    });
  } catch (err) {
    useStatic();
    return;
  }

  /* ---------- Fullscreen quad ---------- */
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  function blit(target) {
    if (target) {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    } else {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  /* ---------- Framebuffers ---------- */
  function createFBO(w, h, fmt, filter) {
    gl.activeTexture(gl.TEXTURE0);
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, w, h, 0, fmt.format, ext.type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture: texture, fbo: fbo, width: w, height: h, texelX: 1 / w, texelY: 1 / h,
      attach: function (id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; },
      dispose: function () { gl.deleteFramebuffer(fbo); gl.deleteTexture(texture); }
    };
  }

  function createDoubleFBO(w, h, fmt, filter) {
    var a = createFBO(w, h, fmt, filter), b = createFBO(w, h, fmt, filter);
    return {
      width: w, height: h, texelX: 1 / w, texelY: 1 / h, read: a, write: b,
      swap: function () { var t = this.read; this.read = this.write; this.write = t; }
    };
  }

  // Resize while keeping current contents (avoids a flash on mobile URL bar resize)
  function resizeDoubleFBO(target, w, h, fmt, filter) {
    if (target.width === w && target.height === h) return target;
    var next = createDoubleFBO(w, h, fmt, filter);
    P.copy.bind();
    gl.uniform1i(P.copy.u.uTexture, target.read.attach(0));
    blit(next.read);
    target.read.dispose(); target.write.dispose();
    return next;
  }

  function getResolution(res) {
    var aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    var min = Math.round(res), max = Math.round(res * aspect);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? { w: max, h: min } : { w: min, h: max };
  }

  var dye, velocity, divergence, curl, pressure;
  var filter = ext.linear ? gl.LINEAR : gl.NEAREST;

  function initFramebuffers() {
    var sim = getResolution(CONFIG.SIM_RESOLUTION);
    var dyeRes = getResolution(CONFIG.DYE_RESOLUTION);
    gl.disable(gl.BLEND);

    if (!dye) dye = createDoubleFBO(dyeRes.w, dyeRes.h, ext.rgba, filter);
    else dye = resizeDoubleFBO(dye, dyeRes.w, dyeRes.h, ext.rgba, filter);

    if (!velocity) velocity = createDoubleFBO(sim.w, sim.h, ext.rg, filter);
    else velocity = resizeDoubleFBO(velocity, sim.w, sim.h, ext.rg, filter);

    if (divergence) { divergence.dispose(); curl.dispose(); pressure.read.dispose(); pressure.write.dispose(); }
    divergence = createFBO(sim.w, sim.h, ext.r, gl.NEAREST);
    curl = createFBO(sim.w, sim.h, ext.r, gl.NEAREST);
    pressure = createDoubleFBO(sim.w, sim.h, ext.r, gl.NEAREST);
  }

  function resizeCanvas() {
    var w = Math.floor(canvas.clientWidth * CONFIG.PIXEL_RATIO);
    var h = Math.floor(canvas.clientHeight * CONFIG.PIXEL_RATIO);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      return true;
    }
    return false;
  }

  /* ---------- Simulation step ---------- */
  function step(dt) {
    gl.disable(gl.BLEND);

    P.curl.bind();
    gl.uniform2f(P.curl.u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(P.curl.u.uVelocity, velocity.read.attach(0));
    blit(curl);

    P.vorticity.bind();
    gl.uniform2f(P.vorticity.u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(P.vorticity.u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(P.vorticity.u.uCurl, curl.attach(1));
    gl.uniform1f(P.vorticity.u.curl, CONFIG.CURL);
    gl.uniform1f(P.vorticity.u.dt, dt);
    blit(velocity.write); velocity.swap();

    P.divergence.bind();
    gl.uniform2f(P.divergence.u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(P.divergence.u.uVelocity, velocity.read.attach(0));
    blit(divergence);

    P.clear.bind();
    gl.uniform1i(P.clear.u.uTexture, pressure.read.attach(0));
    gl.uniform1f(P.clear.u.value, CONFIG.PRESSURE);
    blit(pressure.write); pressure.swap();

    P.pressure.bind();
    gl.uniform2f(P.pressure.u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(P.pressure.u.uDivergence, divergence.attach(0));
    for (var i = 0; i < CONFIG.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(P.pressure.u.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    P.gradientSubtract.bind();
    gl.uniform2f(P.gradientSubtract.u.texelSize, velocity.texelX, velocity.texelY);
    gl.uniform1i(P.gradientSubtract.u.uPressure, pressure.read.attach(0));
    gl.uniform1i(P.gradientSubtract.u.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    var adv = P.advection;
    adv.bind();
    gl.uniform2f(adv.u.texelSize, velocity.texelX, velocity.texelY);
    if (adv.u.dyeTexelSize) gl.uniform2f(adv.u.dyeTexelSize, velocity.texelX, velocity.texelY);
    var velId = velocity.read.attach(0);
    gl.uniform1i(adv.u.uVelocity, velId);
    gl.uniform1i(adv.u.uSource, velId);
    gl.uniform1f(adv.u.dt, dt);
    gl.uniform1f(adv.u.dissipation, CONFIG.VELOCITY_DISSIPATION);
    blit(velocity.write); velocity.swap();

    if (adv.u.dyeTexelSize) gl.uniform2f(adv.u.dyeTexelSize, dye.texelX, dye.texelY);
    gl.uniform1i(adv.u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(adv.u.uSource, dye.read.attach(1));
    gl.uniform1f(adv.u.dissipation, CONFIG.DENSITY_DISSIPATION);
    blit(dye.write); dye.swap();
  }


   function render() {
  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);   // draw to the screen, not the dye buffer
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  gl.clear(gl.COLOR_BUFFER_BIT);
  P.display.bind();
  gl.uniform1i(P.display.u.uTexture, dye.read.attach(0));
  blit(null);
}

  /* ---------- Splats (injecting color + force) ---------- */
  function correctRadius(r) {
    var aspect = canvas.width / canvas.height;
    return aspect > 1 ? r * aspect : r;
  }

  function splat(x, y, dx, dy, color) {
    P.splat.bind();
    gl.uniform1i(P.splat.u.uTarget, velocity.read.attach(0));
    gl.uniform1f(P.splat.u.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(P.splat.u.point, x, y);
    gl.uniform3f(P.splat.u.color, dx, dy, 0);
    gl.uniform1f(P.splat.u.radius, correctRadius(CONFIG.SPLAT_RADIUS / 100));
    blit(velocity.write); velocity.swap();

    gl.uniform1i(P.splat.u.uTarget, dye.read.attach(0));
    gl.uniform3f(P.splat.u.color, color[0], color[1], color[2]);
    blit(dye.write); dye.swap();
  }

  // Blend between two neighbouring palette colors for a curated, non-rainbow feel
  var hueCursor = Math.random() * PALETTE.length;
  function nextColor() {
    hueCursor = (hueCursor + 0.35 + Math.random() * 0.3) % PALETTE.length;
    var i = Math.floor(hueCursor), t = hueCursor - i;
    var a = PALETTE[i], b = PALETTE[(i + 1) % PALETTE.length], k = CONFIG.COLOR_INTENSITY;
    return [(a[0] + (b[0] - a[0]) * t) * k, (a[1] + (b[1] - a[1]) * t) * k, (a[2] + (b[2] - a[2]) * t) * k];
  }

  function randomSplats(n) {
    for (var i = 0; i < n; i++) {
      var c = nextColor();
      splat(Math.random(), Math.random(), 900 * (Math.random() - 0.5), 900 * (Math.random() - 0.5), [c[0] * 3, c[1] * 3, c[2] * 3]);
    }
  }

  /* ---------- Pointer + touch input ---------- */
  var pointer = { x: 0, y: 0, dx: 0, dy: 0, moved: false, active: false, color: nextColor(), colorTime: 0 };
  var lastInput = performance.now();

  function updatePointer(clientX, clientY) {
    var x = clientX / window.innerWidth;
    var y = 1.0 - (clientY / window.innerHeight);
    
    if (!pointer.active) {
      pointer.active = true;
      pointer.x = x; 
      pointer.y = y;
      return;
    }
    
    var aspect = canvas.width / canvas.height;
    pointer.dx += (x - pointer.x) * (aspect < 1 ? aspect : 1.0);
    pointer.dy += (y - pointer.y) / (aspect > 1 ? aspect : 1.0);
    pointer.x = x; 
    pointer.y = y;
    
    // Always trigger movement while active so light cursor shifts register
    pointer.moved = true;
    lastInput = performance.now();
  }

// Bind pointermove and touchmove inputs

   window.addEventListener("pointermove", function (e) {
    if (e.pointerType !== "touch") {
      updatePointer(e.clientX, e.clientY);
    }
  }, { passive: true });
   
  window.addEventListener("touchstart", function (e) {
    var t = e.touches[0];
    pointer.active = false;
    pointer.color = nextColor();
    updatePointer(t.clientX, t.clientY);
  }, { passive: true });

  window.addEventListener("touchmove", function (e) {
    var t = e.touches[0];
    updatePointer(t.clientX, t.clientY);
  }, { passive: true });

  window.addEventListener("touchend", function () { 
    pointer.active = false; 
  }, { passive: true });

  document.addEventListener("mouseleave", function () { 
    pointer.active = false; 
  });

  /* ---------- Main loop ---------- */
  var lastTime = performance.now();
  var running = true;
  var rafId;

  function frame(now) {
    if (!running) return;
    var dt = Math.min((now - lastTime) / 1000, 0.016666);
    lastTime = now;

    if (resizeCanvas()) initFramebuffers();

    if (now - pointer.colorTime > 900) { pointer.color = nextColor(); pointer.colorTime = now; }
   if (pointer.moved) {
      pointer.moved = false;
      splat(
        pointer.x, 
        pointer.y, 
        pointer.dx * CONFIG.SPLAT_FORCE, 
        pointer.dy * CONFIG.SPLAT_FORCE, 
        [
          pointer.color[0] * CONFIG.POINTER_COLOR_BOOST, 
          pointer.color[1] * CONFIG.POINTER_COLOR_BOOST, 
          pointer.color[2] * CONFIG.POINTER_COLOR_BOOST
        ]
      );
      pointer.dx = 0;
      pointer.dy = 0;
    }
    if (now - lastInput > CONFIG.IDLE_SPLAT_MS) {
      lastInput = now;
      randomSplats(1);
    }

    step(dt);
    render();
    rafId = requestAnimationFrame(frame);
  }

 // Pause when the tab is hidden; resume cleanly
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { running = false; cancelAnimationFrame(rafId); }
    else if (!root.classList.contains("no-fluid")) { running = true; lastTime = performance.now(); rafId = requestAnimationFrame(frame); }
  });

  // If the visitor switches on reduced motion mid-visit, stop and show the static gradient
  var onMotionChange = function (e) {
    if (e.matches) { running = false; cancelAnimationFrame(rafId); useStatic(); }
  };
  if (motionQuery.addEventListener) motionQuery.addEventListener("change", onMotionChange);
  else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);

  // Recover from a lost GPU context by falling back to the static gradient
  canvas.addEventListener("webglcontextlost", function (e) { e.preventDefault(); running = false; useStatic(); });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFluid);
  } else {
    initFluid();
  }

  function initFluid() {
    resizeCanvas();
    initFramebuffers();
    randomSplats(isSmall ? 3 : 5);
    rafId = requestAnimationFrame(frame);
  }
})();
