/**
 * FRANKY LAB — Herramienta INTERNA de validación de semántica de opcodes.
 *
 * IMPORTANTE (consolidación de Fase 3): este archivo YA NO se usa en la UI
 * de producción. Existe un único Blockly en todo el ecosistema — el que
 * ya está integrado en providers/franky-server-4.0/assets/bloques.html
 * (el Servidor Web oficial) — y FRANKY LAB lo reutiliza vía iframe en vez
 * de mantener un editor/compilador propio.
 *
 * Este archivo se conserva solo como herramienta de análisis: sirvió para
 * encontrar y documentar un bug real en bloques.html (ver informe de
 * consolidación) — la traducción de f_if_gt/f_if_lt a instrucciones reales
 * solo condiciona la PRIMERA instrucción del bloque "entonces"; el resto
 * se ejecuta siempre. No se copia a public/ ni lo carga ningún HTML.
 */
export function compileProgram(nodes) {
  const out = [];
  for (const n of nodes) compileNode(n, out);
  return out;
}

function push(out, val) {
  out.push({ op: 90, val });
}

function compileNode(n, out) {
  switch (n.type) {
    case "avanzar": out.push({ op: 1, val: n.vel }); break;
    case "retroceder": out.push({ op: 2, val: n.vel }); break;
    case "izquierda": out.push({ op: 3, val: n.vel }); break;
    case "derecha": out.push({ op: 4, val: n.vel }); break;
    case "detener": out.push({ op: 5, val: 0 }); break;
    case "frenar": out.push({ op: 11, val: 0 }); break;
    case "servo": out.push({ op: 40, val: n.gpio * 1000 + n.angulo }); break;
    case "gpio_out": out.push({ op: 20, val: n.gpio * 10 + n.nivel }); break;
    case "led_on": out.push({ op: 7, val: 0 }); break;
    case "led_off": out.push({ op: 8, val: 0 }); break;
    case "pwm_out": out.push({ op: 22, val: n.val }); break;
    case "leer_adc": out.push({ op: 30, val: n.pin }); break;
    case "leer_borde_izq": out.push({ op: 110, val: 0 }); break;
    case "leer_borde_der": out.push({ op: 111, val: 0 }); break;
    case "leer_linea_izq": out.push({ op: 112, val: 0 }); break;
    case "leer_linea_centro": out.push({ op: 113, val: 0 }); break;
    case "leer_linea_der": out.push({ op: 114, val: 0 }); break;
    case "esperar": out.push({ op: 6, val: n.ms }); break;
    case "var_set": out.push({ op: 60, val: n.val }); break;
    case "var_add": out.push({ op: 61, val: n.val }); break;
    case "var_sub": out.push({ op: 62, val: n.val }); break;
    case "leer_millis": out.push({ op: 94, val: 0 }); break;
    case "serial_print": out.push({ op: 122, val: 0, txt: n.texto }); break;
    case "oled_init": out.push({ op: 101, val: 0 }); break;
    case "oled_clear": out.push({ op: 102, val: 0 }); break;
    case "oled_cursor": push(out, n.x); push(out, n.y); out.push({ op: 103, val: 0 }); break;
    case "oled_print": out.push({ op: 104, val: 0, txt: n.texto }); break;
    case "oled_line": push(out, n.x0); push(out, n.y0); push(out, n.x1); push(out, n.y1); out.push({ op: 105, val: 0 }); break;
    case "oled_rect": push(out, n.x); push(out, n.y); push(out, n.w); push(out, n.h); out.push({ op: 106, val: 0 }); break;
    case "oled_circle": push(out, n.cx); push(out, n.cy); push(out, n.r); out.push({ op: 107, val: 0 }); break;
    case "oled_display": out.push({ op: 108, val: 0 }); break;
    case "math_map":
      push(out, n.value); push(out, n.fromLow); push(out, n.fromHigh); push(out, n.toLow); push(out, n.toHigh);
      out.push({ op: 95, val: 0 });
      break;
    case "math_constrain": push(out, n.value); push(out, n.min); push(out, n.max); out.push({ op: 96, val: 0 }); break;
    case "math_abs": push(out, n.value); out.push({ op: 97, val: 0 }); break;
    case "math_min": push(out, n.a); push(out, n.b); out.push({ op: 98, val: 0 }); break;
    case "math_max": push(out, n.a); push(out, n.b); out.push({ op: 99, val: 0 }); break;
    case "math_random": push(out, n.min); push(out, n.max); out.push({ op: 100, val: 0 }); break;

    case "repeat": {
      for (let i = 0; i < n.count; i++) for (const child of n.body) compileNode(child, out);
      break;
    }

    case "while_var_lt": {
      const startIdx = out.length;
      for (const child of n.body) compileNode(child, out);
      out.push({ op: 120, val: n.threshold - 1 });
      out.push({ op: 91, val: startIdx });
      break;
    }

    case "if_adc_gt": {
      out.push({ op: 9, val: n.threshold });
      const jmpOverIdx = out.length;
      out.push({ op: 91, val: 0 });
      for (const child of n.body) compileNode(child, out);
      out[jmpOverIdx] = { op: 91, val: out.length };
      break;
    }
    case "if_var_gt": {
      out.push({ op: 120, val: n.threshold });
      const jmpOverIdx = out.length;
      out.push({ op: 91, val: 0 });
      for (const child of n.body) compileNode(child, out);
      out[jmpOverIdx] = { op: 91, val: out.length };
      break;
    }
    case "if_var_lt": {
      out.push({ op: 121, val: n.threshold });
      const jmpOverIdx = out.length;
      out.push({ op: 91, val: 0 });
      for (const child of n.body) compileNode(child, out);
      out[jmpOverIdx] = { op: 91, val: out.length };
      break;
    }
    default:
      break;
  }
}
