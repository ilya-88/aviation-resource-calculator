function attachFormulaEditor(panel, initial, sources, currentKey, unit, escapeHtml) {
  const expression = structuredClone(initial || { tokens: [], emptyZero: false });
  panel.innerHTML = `<output class="formula-line" aria-live="polite"></output>
    <div class="formula-keys" data-cell-list></div>
    <div class="field-pair"><select data-source-picker aria-label="Другие поля записи"></select><button type="button" class="small-button" data-insert-source>Вставить поле</button></div>
    <div class="formula-keys" data-operations></div>
    <div class="field-pair"><label>Число или шаг округления<input inputmode="decimal" data-number placeholder="0,2"></label>
    <div class="formula-keys"><button type="button" class="small-button" data-insert-number>Число</button>
    <button type="button" class="small-button" data-round>Округлить до</button></div></div>
    <label class="checkbox-row"><input type="checkbox" data-zero>Пустое поле считать нулём, если заполнено другое поле</label>
    <button type="button" class="small-button" data-undo>Убрать последний знак</button>
    <small data-check aria-live="polite"></small>`;
  const find = selector => panel.querySelector(selector);
  const output = find("output"), status = find("[data-check]"), picker = find("[data-source-picker]");
  const zero = find("[data-zero]");
  zero.checked = expression.emptyZero;
  function push(token) {
    if (expression.tokens.length >= 100) { status.textContent = "В выражении уже 100 элементов"; return; }
    expression.tokens.push(token);
    refresh();
  }
  function refresh() {
    const all = sources();
    const keys = [...all.values()].filter(item => item.key !== currentKey && item.unit !== "текст");
    const cells = keys.filter(item => item.key.startsWith("cell:") || item.key.startsWith("position:"));
    find("[data-cell-list]").innerHTML = cells.map(item =>
      `<button type="button" class="small-button" data-ref="${escapeHtml(item.key)}">${escapeHtml(item.label)}</button>`).join("");
    const previous = picker.value;
    picker.innerHTML = keys.filter(item => !cells.includes(item)).map(item =>
      `<option value="${escapeHtml(item.key)}">${escapeHtml(item.label)}</option>`).join("");
    if ([...picker.options].some(option => option.value === previous)) picker.value = previous;
    find("[data-round]").textContent = "Округлить до (" + unit() + ")";
    output.textContent = formulas.describe(expression, all) || "Выбери первую графу";
    try {
      formulas.calculate(expression, unit(), all);
      status.textContent = "Единица результата: " + unit();
    } catch (error) { status.textContent = expression.tokens.length ? error.message : ""; }
  }
  const labels = { "*": "×", "/": "÷", "-": "−" };
  find("[data-operations]").innerHTML = ["+", "-", "*", "/", "(", ")", "%"].map(op =>
    `<button type="button" class="small-button" data-op="${op}">${labels[op] || op}</button>`).join("");
  panel.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.ref) push({ ref: button.dataset.ref });
    else if (button.dataset.op) push(button.dataset.op);
    else if (button.hasAttribute("data-insert-source") && picker.value) push({ ref: picker.value });
    else if (button.hasAttribute("data-undo")) { expression.tokens.pop(); refresh(); }
    else if (button.hasAttribute("data-round") || button.hasAttribute("data-insert-number")) {
      const raw = find("[data-number]").value.trim().replace(",", ".");
      const value = Number(raw), round = button.hasAttribute("data-round");
      if (!raw || !Number.isFinite(value) || (round && value <= 0)) { status.textContent = "Проверь введённое число"; return; }
      push(round ? { round: value } : value);
      find("[data-number]").value = "";
    }
  });
  zero.onchange = () => { expression.emptyZero = zero.checked; };
  return { refresh, expression };
}
