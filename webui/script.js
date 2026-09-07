let globalInstrumentsCache = [], currentExecutingIndex = -1, scanQueue = [], chipsList = [];
let _chipsModified = false;
let scanStatusPollTimer = null;
let tabSid = sessionStorage.getItem("tab_sid");
if (!tabSid) {
    tabSid = crypto.randomUUID();
    sessionStorage.setItem("tab_sid", tabSid);
}
const DEFAULT_CONFIG = {
    data_dir: '', user: '', exp_name: '', fridge: '', chip1_name: '',
    x_start: null, x_stop: null, x_points: 101, x_delay: 0.01,
    y_start: null, y_stop: null, y_points: 1, y_delay: 0.1, scan_bwd: false
};

async function apiFetch(endpoint, options = {}) {
    const headersObj = {
        'Content-Type': 'application/json',
        "X-Tab-Session-Id": tabSid,
        ...(options.headers || {})
    };
    const res = await fetch(endpoint, { 
        headers: headersObj, 
        ...options 
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
}

const apiGet = (ep) => apiFetch(ep);
const apiPost = (ep, data) => apiFetch(ep, { method: 'POST', body: JSON.stringify(data) });
const getInstrumentParameterApi = (param) => apiPost('/api/station/get_instrument_parameter', { parameter: param });
const setInstrumentParameterApi = (param, value) => apiPost('/api/station/set_instrument_parameter', { parameter: param, value });

function toggleDropdown(e) {
    e.stopPropagation();
    document.getElementById('dropdownListPanel')?.classList.toggle('show');
}

function openImageModal(url, caption) {
    document.getElementById('imageModal').classList.add('show');
    document.getElementById('modalImage').src = url;
    document.getElementById('modalCaption').innerText = caption || '';
}

function closeImageModal() {
    document.getElementById('imageModal').classList.remove('show');
}

// 统一的全局点击事件监听器
window.addEventListener('click', (e) => {
    document.getElementById('dropdownListPanel')?.classList.remove('show');
    
    const inlineAddInst = document.getElementById('inlineAddInstrumentRow');
    if (inlineAddInst && !inlineAddInst.contains(e.target) && !e.target.closest('button[onclick*="addInstrument"]')) {
        inlineAddInst.remove();
    }
    
    const inlineExport = document.getElementById('inlineExportConfigRow');
    if (inlineExport && !inlineExport.contains(e.target) && !e.target.closest('button[onclick*="exportConfigFile"]')) {
        inlineExport.remove();
    }

    document.querySelectorAll('[id^="inlineRemoveInstRow_"]').forEach(row => {
        if (!row.contains(e.target) && !e.target.closest('button[onclick*="toggleRemoveInstrumentRow"]')) row.remove();
    });
    document.querySelectorAll('[id^="inlineAddParamRow_"]').forEach(row => {
        if (!row.contains(e.target) && !e.target.closest('button[onclick*="toggleAddSpecificParamRow"]')) row.remove();
    });
    document.querySelectorAll('[id^="inlineRemoveParamRow_"]').forEach(row => {
        if (!row.contains(e.target) && !e.target.closest('button[onclick*="removeUnifiedParam"]')) row.remove();
    });
    document.querySelectorAll('[id^="inlineRemoveChipRow_"]').forEach(row => {
        if (!row.contains(e.target) && !e.target.closest('button[onclick*="toggleRemoveChipRow"]')) row.remove();
    });
});

function validateRange(inputEl) {
    if (inputEl.value === '') return;
    let val = parseFloat(inputEl.value), min = inputEl.min !== '' ? parseFloat(inputEl.min) : null, max = inputEl.max !== '' ? parseFloat(inputEl.max) : null;
    if (isNaN(val)) return;
    if (max !== null && val > max) inputEl.value = max;
    else if (min !== null && val < min) inputEl.value = min;
}

function parseInputValue(inputEl) {
    if (!inputEl || inputEl.value === '') return '';
    if (inputEl.type === 'number' || inputEl.hasAttribute('step') || inputEl.hasAttribute('min') || inputEl.hasAttribute('max')) {
        const num = Number(inputEl.value);
        return isNaN(num) ? inputEl.value : num;
    }
    return inputEl.value;
}

function getAllParametersOptionsHtml(selectedVal = 'None') {
    let optionsHtml = '<option value="None">None</option>';
    if (!globalInstrumentsCache.length) return optionsHtml;
    globalInstrumentsCache.forEach(inst => {
        if (inst.parameters) {
            Object.keys(inst.parameters).forEach(pName => {
                const fullKey = `${inst.key}.${pName}`;
                optionsHtml += `<option value="${fullKey}" ${fullKey === selectedVal ? 'selected' : ''}>${fullKey}</option>`;
            });
        }
    });
    return optionsHtml;
}

function populateCustomDropdown() {
    const dropdownEl = document.getElementById('customDropdown');
    if (dropdownEl) dropdownEl.innerHTML = getAllParametersOptionsHtml(dropdownEl.value);
}

function initTextInputTooltips() {
    document.querySelectorAll('input[type="text"]').forEach(input => {
        if (!input.getAttribute('title')) input.setAttribute('title', input.value);
        if (!input.dataset.tooltipBound) {
            input.addEventListener('input', () => { input.title = input.value; });
            input.dataset.tooltipBound = "true";
        }
    });
}

function toggleAllInstruments() {
    const cards = document.querySelectorAll('.instrument-card');
    if (cards.length === 0) return;
    const allExpanded = Array.from(cards).every(card => card.classList.contains('expanded'));
    cards.forEach(card => card.classList.toggle('expanded', !allExpanded));
}
window.toggleAllInstruments = toggleAllInstruments;

function markStorageModified(inputEl) {
    inputEl.classList.add('dirty-input');
    inputEl.dataset.modified = "true";
}

function clearStorageInputModifications() {
    ['dataDirInput', 'userInput', 'expName', 'fridgeInput', 'chip1NameInput', 'logDirInput', 'portInput'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.remove('dirty-input');
            delete el.dataset.modified;
        }
    });
}

window.getStorageConf = async function getStorageConf() {
    try {
        await loadSettings();
    } catch (err) {
        alert("Failed to read storage settings: " + err.message);
    }
};

window.setStorageConf = async function setStorageConf() {
    await updateStorageSettings();
};

async function loadSettings() {
    try {
        const data = await apiPost('/api/scan/get_storage_conf', {});
        document.getElementById('dataDirInput').value = data.data_dir ?? DEFAULT_CONFIG.data_dir;
        document.getElementById('userInput').value = data.user ?? DEFAULT_CONFIG.user;
        document.getElementById('expName').value = data.exp_name ?? DEFAULT_CONFIG.exp_name;
        document.getElementById('fridgeInput').value = data.fridge ?? DEFAULT_CONFIG.fridge;
        document.getElementById('calculatedDataPath').value = data.calced_work_path ?? DEFAULT_CONFIG.calced_work_path;

        
        const chip1NameInput = document.getElementById('chip1NameInput');
        if (chip1NameInput) chip1NameInput.value = data.chip1_name ?? DEFAULT_CONFIG.chip1_name;
        if (data.chip1_name && chipsList.length > 0) {
            chipsList[0].name = data.chip1_name;
            renderChipsContainer();
        }
        const logDirInput = document.getElementById('logDirInput');
        if (logDirInput && data.log_dir) logDirInput.value = data.log_dir;
        const portInput = document.getElementById('portInput');
        if (portInput && data.port) portInput.value = data.port;
        
        clearStorageInputModifications();
    } catch (_) {
        setDefaultStorageValues();
    }
    initTextInputTooltips();
}

async function updateStorageSettings() {
    const payload = {
        fridge: document.getElementById('fridgeInput').value.trim(),
        exp_name: document.getElementById('expName').value.trim(),
        chip1_name: document.getElementById('chip1NameInput')?.value.trim(),
        user: document.getElementById('userInput').value.trim(),
        data_dir: document.getElementById('dataDirInput').value.trim()
    };
    try {
        await apiPost('/api/scan/set_storage_conf', payload);
        await loadSettings();
    } catch (err) {
        alert('Failed to update storage settings: ' + err.message);
    }
}
window.updateStorageSettings = updateStorageSettings;

function setDefaultStorageValues() {
    document.getElementById('dataDirInput').value = DEFAULT_CONFIG.data_dir;
    document.getElementById('userInput').value = DEFAULT_CONFIG.user;
    document.getElementById('expName').value = DEFAULT_CONFIG.exp_name;
    document.getElementById('fridgeInput').value = DEFAULT_CONFIG.fridge;
    const chip1NameInput = document.getElementById('chip1NameInput');
    if (chip1NameInput) chip1NameInput.value = DEFAULT_CONFIG.chip1_name;
}

async function openDataFolder() {
    const path = document.getElementById('calculatedDataPath').value.trim();
    if (!path || path === 'Not specified') { alert('Data path is incomplete!'); return; }
    try { await apiPost('/api/scan/open_folder', { path }); } catch (err) { alert('Failed to open folder: ' + err.message); }
}

async function fetchAvailableInstrumentClasses() {
    try {
        const res = await apiPost('/api/station/get_available_instrument_drivers', {});
        return Array.isArray(res) ? res : (res && Array.isArray(res.classes) ? res.classes : []);
    } catch (err) {
        console.error("Failed to fetch available instrument classes:", err);
        return [];
    }
}

async function addInstrument() {
    let inlineRow = document.getElementById('inlineAddInstrumentRow');
    if (inlineRow) { inlineRow.remove(); return; }
    const availableClasses = await fetchAvailableInstrumentClasses();
    const classOptionsHtml = availableClasses.map(c => `<option value="${c}">`).join('');
    const grid = document.getElementById('instrumentGrid');
    if (!grid) return;

    inlineRow = document.createElement('div');
    inlineRow.id = 'inlineAddInstrumentRow';
    inlineRow.style.cssText = 'display: flex; gap: 8px; align-items: center; padding: 10px; background: #f8fafc; border: 1px dashed var(--primary, #6366f1); border-radius: 6px; margin-bottom: 12px; grid-column: 1 / -1;';
    inlineRow.innerHTML = `
        <span style="font-size: 0.8rem; font-weight: 600; color: var(--secondary);">Add Inst:</span>
        <input type="text" id="inlineInstName" placeholder="Name..." class="table-input" style="flex: 1;" autocomplete="off">
        <input type="text" id="inlineInstClass" list="inlineClassList" placeholder="Class..." class="table-input" style="flex: 2;" autocomplete="off">
        <datalist id="inlineClassList">${classOptionsHtml}</datalist>
        <input type="text" id="inlineInstAddress" placeholder="Address (optional)..." class="table-input" style="flex: 2;" autocomplete="off">
        <button class="btn-primary btn-sm" title="Add instrument" onclick="confirmAddInlineInstrument()">Add</button>
        <button class="btn-secondary btn-sm" onclick="document.getElementById('inlineAddInstrumentRow').remove()">Cancel</button>
    `;
    grid.insertBefore(inlineRow, grid.firstChild);
    document.getElementById('inlineInstName')?.focus();
}

async function confirmAddInlineInstrument() {
    const nameEl = document.getElementById('inlineInstName'), classEl = document.getElementById('inlineInstClass'), addressEl = document.getElementById('inlineInstAddress');
    if (!nameEl || !classEl || !addressEl) return;
    const name = nameEl.value.trim(), klass = classEl.value.trim(), address = addressEl.value.trim();
    if (!name || !klass) { alert('Name and Class are required!'); return; }
    try {
        await apiPost('/api/station/add_instrument', { name, 'class': klass, address });
        document.getElementById('inlineAddInstrumentRow')?.remove(); // 修复原代码拼写错误 Bug
        await getStationInstruments();
        await fetchParametersJson();
    } catch (err) { alert('Failed to add instrument: ' + err.message); }
}

window.addInstrument = addInstrument;
window.confirmAddInlineInstrument = confirmAddInlineInstrument;

function toggleRemoveInstrumentRow(instKey) {
    const rowId = `inlineRemoveInstRow_${instKey}`;
    let existingRow = document.getElementById(rowId);
    if (existingRow) { existingRow.remove(); return; }
    const targetCard = Array.from(document.querySelectorAll('.instrument-card')).find(card => card.querySelector('.instrument-title')?.textContent.trim() === instKey);
    if (!targetCard) return;

    const inlineRow = document.createElement('div');
    inlineRow.id = rowId;
    inlineRow.style.cssText = 'display: flex; gap: 6px; align-items: center; padding: 8px 12px; background: #fef2f2; border: 1px dashed #ef4444; border-radius: 6px; margin: 8px 0; flex: 1; box-sizing: border-box;';
    inlineRow.innerHTML = `
        <span style="font-size: 0.8rem; font-weight: 600; color: #dc2626;">Remove "${instKey}"?</span>
        <div style="margin-left: auto; display: flex; gap: 6px;">
            <button class="btn-danger btn-sm" style="padding: 2px 8px; background: #dc2626; color: white; border: none; border-radius: 4px; cursor: pointer;" onclick="confirmRemoveInstrument('${instKey}')">Confirm</button>
            <button class="btn-secondary btn-sm" style="padding: 2px 8px;" onclick="document.getElementById('${rowId}').remove()">Cancel</button>
        </div>
    `;
    targetCard.querySelector('.instrument-header')?.insertAdjacentElement('afterend', inlineRow);
}

async function confirmRemoveInstrument(instKey) {
    try {
        await apiPost('/api/station/remove_instrument', { name: instKey });
        await getStationInstruments();
        await fetchParametersJson();
    } catch (err) { alert('Failed to remove instrument: ' + err.message); }
}

window.toggleRemoveInstrumentRow = toggleRemoveInstrumentRow;
window.confirmRemoveInstrument = confirmRemoveInstrument;

async function getStationInstruments() {
    const grid = document.getElementById('instrumentGrid'), errBox = document.getElementById('instErrorBox');
    if (errBox) errBox.style.display = 'none';
    try {
        const data = await apiPost('/api/station/get_all_instruments', {});
        let instruments = Array.isArray(data) ? data : (data.instruments || Object.entries(data).map(([k, v]) => ({ key: k, ...v })));
        globalInstrumentsCache = instruments;
        grid.innerHTML = instruments.length ? '' : '<div style="color:var(--muted);grid-column:1/-1;padding:16px 0;text-align:center;">No hardware instruments mounted</div>';

        instruments.forEach(inst => {
            const card = document.createElement('div');
            card.className = 'instrument-card expanded';
            card.title = "Toggle instrument card";
            let paramsHtml = '';

            Object.entries(inst.parameters || {}).forEach(([pName, pVal]) => {
                const isSettable = pVal.settable !== false, guiMeta = pVal.metadata, isEnum = guiMeta.type === 'enum';
                const isDropdown = isEnum || guiMeta.type === 'parameter' || pVal.metadata?.type === 'parameter';
                const fullKey = `${inst.key}.${pName}`;
                let inputHtml = '';

                if (isDropdown) {
                    let optionsHtml = isEnum && Array.isArray(guiMeta.values) ? guiMeta.values.map(val => `<option value="${val}" ${val === pVal.value ? 'selected' : ''}>${val}</option>`).join('') : getAllParametersOptionsHtml(pVal.value);
                    const attrs = isSettable ? '' : 'disabled style="background-color: var(--bg-disabled, #f1f5f9); color: var(--muted, #94a3b8); cursor: not-allowed;"';
                    inputHtml = `<select id="input_${inst.key}_${pName}" class="table-input" style="flex: 1;" ${attrs} oninput="markParamAsModified(this)">${optionsHtml}</select>`;
                } else if (Array.isArray(pVal.value)) {
                    const is2DArray = pVal.value.length > 0 && Array.isArray(pVal.value[0]);
                    const attrs = isSettable ? '' : 'readonly style="background-color: var(--bg-disabled, #f1f5f9); color: var(--muted, #94a3b8); cursor: not-allowed;"';
                    if (is2DArray) {
                        let matrixHtml = `<div class="matrix-inputs-container" data-array-container="${inst.key}.${pName}" style="display: flex; flex-direction: column; gap: 4px; flex: 1;">`;
                        pVal.value.forEach((rowItem, rIdx) => {
                            matrixHtml += `<div style="display: flex; gap: 4px; align-items: center; flex: 1;"><span style="font-size: 0.7rem; color: var(--muted); min-width: 18px;">[${rIdx}]</span>`;
                            if (Array.isArray(rowItem)) {
                                rowItem.forEach((colItem, cIdx) => {
                                    const isNumeric = typeof colItem === 'number', cellVal = colItem ?? '';
                                    matrixHtml += `<input type="${isNumeric ? 'number' : 'text'}" class="param-value table-input matrix-cell" data-row="${rIdx}" data-col="${cIdx}" value="${cellVal}" title="${cellVal}" ${isNumeric ? 'step="any"' : ''} ${attrs} style="flex: 1; min-width: 40px;" oninput="this.title=this.value; markParamAsModified(this)">`;
                                });
                            }
                            matrixHtml += `</div>`;
                        });
                        inputHtml = matrixHtml + `</div>`;
                    } else {
                        const isNumericArray = pVal.value.length > 0 && typeof pVal.value[0] === 'number', inputType = isNumericArray ? 'number' : 'text';
                        let arrayInputsHtml = `<div class="array-inputs-container" data-array-container="${inst.key}.${pName}" style="display: flex; flex-direction: column; gap: 4px; flex: 1;">`;
                        pVal.value.forEach((item, idx) => {
                            const itemVal = item ?? '';
                            arrayInputsHtml += `<div style="display: flex; align-items: center; gap: 4px; flex: 1;"><span style="font-size: 0.7rem; color: var(--muted); min-width: 16px;">[${idx}]</span><input type="${inputType}" class="param-value table-input" value="${itemVal}" title="${itemVal}" ${inputType === 'number' ? 'step="any"' : ''} ${attrs} style="flex: 1;" oninput="this.title=this.value; markParamAsModified(this)"></div>`;
                        });
                        inputHtml = arrayInputsHtml + `</div>`;
                    }
                } else if (pVal.value !== null && typeof pVal.value === 'object' && !Array.isArray(pVal.value)) {
                    const attrs = isSettable ? '' : 'readonly style="background-color: var(--bg-disabled, #f1f5f9); color: var(--muted, #94a3b8); cursor: not-allowed;"';
                    let dictInputsHtml = `<div class="dict-inputs-container" data-dict-container="${inst.key}.${pName}" style="display: flex; flex-direction: column; gap: 4px; flex: 1;">`;
                    Object.entries(pVal.value).forEach(([dictKey, dictVal]) => {
                        const isNumeric = (typeof dictVal === 'number' && !isNaN(dictVal)) || (dictVal !== '' && !isNaN(Number(dictVal)));
                        const dVal = dictVal ?? '';
                        dictInputsHtml += `<div style="display: flex; align-items: center; gap: 4px; flex: 1;"><span style="font-size: 0.7rem; color: var(--muted); max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${dictKey}">${dictKey}:</span><input type="${isNumeric ? 'number' : 'text'}" class="param-value table-input" data-dict-key="${dictKey}" value="${dVal}" title="${dVal}" ${isNumeric ? 'step="any"' : ''} ${attrs} style="flex: 1;" oninput="this.title=this.value; markParamAsModified(this)"></div>`;
                    });
                    inputHtml = dictInputsHtml + `</div>`;
                } else {
                    const attrs = isSettable ? '' : 'readonly style="background-color: var(--bg-disabled, #f1f5f9); color: var(--muted, #94a3b8); cursor: not-allowed;"';
                    const val = pVal.value ?? '', hasMin = pVal.min_value != null, hasMax = pVal.max_value != null;
                    const minMaxAttrs = (hasMin ? ` min="${pVal.min_value}"` : '') + (hasMax ? ` max="${pVal.max_value}"` : '');
                    const inputType = (typeof val === 'number' || hasMin || hasMax) ? 'number' : 'text';
                    let tooltipAttr = `title="${val}"`;
                    if (inputType === 'number') {
                        tooltipAttr = `title="min: ${hasMin ? pVal.min_value : 'None'} | max: ${hasMax ? pVal.max_value : 'None'} | step: ${pVal.step ?? 'None'} | interdelay: ${pVal.inter_delay ?? 'None'}"`;
                    }
                    inputHtml = `<input type="${inputType}" id="input_${inst.key}_${pName}" class="param-value table-input" value="${val}" ${tooltipAttr} placeholder=""${minMaxAttrs}${attrs} onblur="validateRange(this)" oninput="markParamAsModified(this)" style="flex: 1;">`;
                }

                paramsHtml += `
                    <div class="param-item-row" id="param_row_${inst.key}_${pName}">
                        <div class="param-actions" style="flex-flow:row;">
                            <div class="param-name-label" title="${pName}">${pVal.label || pName}</div>
                            ${inputHtml}
                            <span class="unit-label">${pVal.unit || ''}</span>
							<div class=\"cell-row-single\">
								<button class="btn-secondary btn-sm" title="Read" onclick="event.stopPropagation();readParam('${inst.key}','${pName}')">🔍</button>
								<button class="btn-secondary btn-sm" title="Write" ${isSettable ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'} onclick="event.stopPropagation();setParam('${inst.key}','${pName}')">✏️</button>
								<button class="btn-secondary btn-sm" title="Add" onclick="event.stopPropagation();toggleAddSpecificParamRow('${inst.key}', '${pName}', '${fullKey}')">➕</button>
							</div>
                        </div>
                    </div>`;
            });

            card.innerHTML = `
                <div class="instrument-header" onclick="this.parentElement.classList.toggle('expanded')">
                    <span class="instrument-title">${inst.key}</span>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <button class="btn-secondary btn-sm" title="Remove Instrument" style="background:#faf5ff; border:0;" onclick="event.stopPropagation(); toggleRemoveInstrumentRow('${inst.key}')">➖</button>
                    </div>
                </div>
                <div class="instrument-body"><div class="param-list-container">${paramsHtml || '<div style="color:var(--muted);font-size:.8rem;text-align:center;padding:6px 0;">No parameters</div>'}</div></div>`;
            grid.appendChild(card);
        });

        updateScanAxisDropdowns();
        populateCustomDropdown();
        initTextInputTooltips();
    } catch (err) {
        if (errBox) { errBox.innerText = '❌ ' + err.message; errBox.style.display = 'block'; }
    }
}

function markParamAsModified(inputEl) {
    inputEl.classList.add('dirty-input');
    inputEl.dataset.modified = "true";
}


async function readParam(key, paramName) {
    try {
        // 关键：updt_gui_meta设为true，后端才返回min_value/max_value/step/inter_delay
        const res = await apiPost('/api/station/get_instrument_parameter', {
            parameter: `${key}.${paramName}`,
            updt_gui_meta: false
        });
        if (res !== null && res !== undefined) {
            const val = (typeof res === 'object' && res.value !== undefined) ? res.value : res;
            const inputEl = document.getElementById(`input_${key}_${paramName}`);
            if (inputEl) {
                inputEl.value = val;

                // 仅 number 输入框才更新title和min/max属性，select/其他类型跳过
                if(inputEl.type === "number"){
                    const minVal = res.min_value != null ? res.min_value : "None";
                    const maxVal = res.max_value != null ? res.max_value : "None";
                    const stepVal = res.step != null ? res.step : "None";
                    const interDelayVal = res.inter_delay != null ? res.inter_delay : "None";

                    // 动态生成tooltip，不从DOM读旧title
                    inputEl.title = `min: ${minVal} | max: ${maxVal} | step: ${stepVal} | interdelay: ${interDelayVal}`;

                    // 更新input html min/max属性
                    if(res.min_value != null){
                        inputEl.min = res.min_value;
                    }else{
                        inputEl.removeAttribute("min");
                    }
                    if(res.max_value != null){
                        inputEl.max = res.max_value;
                    }else{
                        inputEl.removeAttribute("max");
                    }
                }

				inputEl.classList.remove('dirty-input');
				delete inputEl.dataset.modified;
                return res;
            }
            await reloadSingleInstrument(key);
        }
        return res;
    } catch (err) { alert('Read failed: ' + err.message); return null; }
}


async function setParam(key, paramName) {
    const inputEl = document.getElementById(`input_${key}_${paramName}`);
    let valueToSend;
    if (inputEl) {
        if (inputEl.tagName !== 'SELECT' && inputEl.value !== '') validateRange(inputEl);
        valueToSend = parseInputValue(inputEl);
    } else {
        const matrixContainer = document.querySelector(`[data-array-container="${key}.${paramName}"].matrix-inputs-container`);
        const arrayContainer = document.querySelector(`[data-array-container="${key}.${paramName}"]`);
        const dictContainer = document.querySelector(`[data-dict-container="${key}.${paramName}"]`);
        
        if (matrixContainer) {
            valueToSend = [];
            matrixContainer.querySelectorAll('div[style*="display: flex"]').forEach(rowDiv => {
                const cellInputs = rowDiv.querySelectorAll('input.matrix-cell');
                if (cellInputs.length > 0) {
                    valueToSend.push(Array.from(cellInputs).map(inp => { const v = inp.value; return (v !== '' && !isNaN(Number(v))) ? Number(v) : v; }));
                }
            });
        } else if (arrayContainer) {
            valueToSend = Array.from(arrayContainer.querySelectorAll('input.param-value')).map(inp => { const v = inp.value; return (v !== '' && !isNaN(Number(v))) ? Number(v) : v; });
        } else if (dictContainer) {
            valueToSend = {};
            dictContainer.querySelectorAll('input.param-value').forEach(inp => {
                const dictKey = inp.getAttribute('data-dict-key');
                if (dictKey) { const v = inp.value; valueToSend[dictKey] = (v !== '' && !isNaN(Number(v))) ? Number(v) : v; }
            });
        }
    }

    if (valueToSend === undefined) { alert('Value not found'); return; }
    try {
        await setInstrumentParameterApi(`${key}.${paramName}`, valueToSend);
        const inst = globalInstrumentsCache.find(i => i.key === key);
        const reloadAfterSet = inst?.parameters?.[paramName]?.metadata?.reload_after_set;
        if (reloadAfterSet === true || reloadAfterSet === 'True' || reloadAfterSet === 'true') await reloadSingleInstrument(key);
        else await readParam(key, paramName);
    } catch (err) { alert('Set failed: ' + err.message); }
}

async function reloadSingleInstrument(instKey) {
    try {
        const data = await apiPost('/api/station/get_instrument', { name: instKey });
        let targetInst = (data && data.parameters) ? { key: data.name || instKey, ...data } : (Array.isArray(data) ? data : (data.instruments || Object.entries(data).map(([k, v]) => ({ key: k, ...v })))).find(i => i.key === instKey);
        if (!targetInst) return;

        const cacheIndex = globalInstrumentsCache.findIndex(i => i.key === instKey);
        if (cacheIndex !== -1) globalInstrumentsCache[cacheIndex] = targetInst;
        else globalInstrumentsCache.push(targetInst);

        const targetCard = Array.from(document.querySelectorAll('.instrument-card')).find(card => card.querySelector('.instrument-title')?.textContent.trim() === instKey);
        if (targetCard) {
            let paramsHtml = '';
            Object.entries(targetInst.parameters || {}).forEach(([pName, pVal]) => {
                const isSettable = pVal.settable !== false, guiMeta = pVal, isEnum = guiMeta.type === 'enum';
                const isDropdown = isEnum || guiMeta.type === 'parameter' || pVal.metadata?.type === 'parameter';
                const fullKey = `${targetInst.key}.${pName}`;
                let inputHtml = '';

                if (isDropdown) {
                    let optionsHtml = isEnum && Array.isArray(guiMeta.values) ? guiMeta.values.map(val => `<option value="${val}" ${val === pVal.value ? 'selected' : ''}>${val}</option>`).join('') : getAllParametersOptionsHtml(pVal.value);
                    const attrs = isSettable ? '' : 'disabled style="background-color: var(--bg-disabled, #f1f5f9); color: var(--muted, #94a3b8); cursor: not-allowed;"';
                    inputHtml = `<select id="input_${targetInst.key}_${pName}" class="table-input" style="flex: 1;" ${attrs} oninput="markParamAsModified(this)">${optionsHtml}</select>`;
                } else if (Array.isArray(pVal.value)) {
                    const is2DArray = pVal.value.length > 0 && Array.isArray(pVal.value[0]);
                    const attrs = isSettable ? '' : 'readonly style="background-color: var(--bg-disabled, #f1f5f9); color: var(--muted, #94a3b8); cursor: not-allowed;"';
                    if (is2DArray) {
                        let matrixHtml = `<div class="matrix-inputs-container" data-array-container="${targetInst.key}.${pName}" style="display: flex; flex-direction: column; gap: 4px; flex: 1;">`;
                        pVal.value.forEach((rowItem, rIdx) => {
                            matrixHtml += `<div style="display: flex; gap: 4px; align-items: center; flex: 1;"><span style="font-size: 0.7rem; color: var(--muted); min-width: 18px;">[${rIdx}]</span>`;
                            if (Array.isArray(rowItem)) {
                                rowItem.forEach((colItem, cIdx) => {
                                    const isNumeric = typeof colItem === 'number', cellVal = colItem ?? '';
                                    matrixHtml += `<input type="${isNumeric ? 'number' : 'text'}" class="param-value table-input matrix-cell" data-row="${rIdx}" data-col="${cIdx}" value="${cellVal}" title="${cellVal}" ${isNumeric ? 'step="any"' : ''} ${attrs} style="flex: 1; min-width: 40px;" oninput="this.title=this.value; markParamAsModified(this)">`;
                                });
                            }
                            matrixHtml += `</div>`;
                        });
                        inputHtml = matrixHtml + `</div>`;
                    } else {
                        const isNumericArray = pVal.value.length > 0 && typeof pVal.value[0] === 'number', inputType = isNumericArray ? 'number' : 'text';
                        let arrayInputsHtml = `<div class="array-inputs-container" data-array-container="${targetInst.key}.${pName}" style="display: flex; flex-direction: column; gap: 4px; flex: 1;">`;
                        pVal.value.forEach((item, idx) => {
                            const itemVal = item ?? '';
                            arrayInputsHtml += `<div style="display: flex; align-items: center; gap: 4px; flex: 1;"><span style="font-size: 0.7rem; color: var(--muted); min-width: 16px;">[${idx}]</span><input type="${inputType}" class="param-value table-input" value="${itemVal}" title="${itemVal}" ${inputType === 'number' ? 'step="any"' : ''} ${attrs} style="flex: 1;" oninput="this.title=this.value; markParamAsModified(this)"></div>`;
                        });
                        inputHtml = arrayInputsHtml + `</div>`;
                    }
                } else if (pVal.value !== null && typeof pVal.value === 'object' && !Array.isArray(pVal.value)) {
                    const attrs = isSettable ? '' : 'readonly style="background-color: var(--bg-disabled, #f1f5f9); color: var(--muted, #94a3b8); cursor: not-allowed;"';
                    let dictInputsHtml = `<div class="dict-inputs-container" data-dict-container="${targetInst.key}.${pName}" style="display: flex; flex-direction: column; gap: 4px; flex: 1;">`;
                    Object.entries(pVal.value).forEach(([dictKey, dictVal]) => {
                        const isNumeric = (typeof dictVal === 'number' && !isNaN(dictVal)) || (dictVal !== '' && !isNaN(Number(dictVal)));
                        const dVal = dictVal ?? '';
                        dictInputsHtml += `<div style="display: flex; align-items: center; gap: 4px; flex: 1;"><span style="font-size: 0.7rem; color: var(--muted); max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${dictKey}">${dictKey}:</span><input type="${isNumeric ? 'number' : 'text'}" class="param-value table-input" data-dict-key="${dictKey}" value="${dVal}" title="${dVal}" ${isNumeric ? 'step="any"' : ''} ${attrs} style="flex: 1;" oninput="this.title=this.value; markParamAsModified(this)"></div>`;
                    });
                    inputHtml = dictInputsHtml + `</div>`;
                } else {
                    const attrs = isSettable ? '' : 'readonly style="background-color: var(--bg-disabled, #f1f5f9); color: var(--muted, #94a3b8); cursor: not-allowed;"';
                    const val = pVal.value ?? '', hasMin = pVal.min_value != null, hasMax = pVal.max_value != null;
                    const minMaxAttrs = (hasMin ? ` min="${pVal.min_value}"` : '') + (hasMax ? ` max="${pVal.max_value}"` : '');
                    const inputType = (typeof val === 'number' || hasMin || hasMax) ? 'number' : 'text';
                    let tooltipAttr = `title="${val}"`;
                    if (inputType === 'number') {
                        tooltipAttr = `title="min: ${hasMin ? pVal.min_value : 'None'} | max: ${hasMax ? pVal.max_value : 'None'} | step: ${pVal.step ?? 'None'} | interdelay: ${pVal.inter_delay ?? 'None'}"`;
                    }
                    inputHtml = `<input type="${inputType}" id="input_${targetInst.key}_${pName}" class="param-value table-input" value="${val}" ${tooltipAttr} placeholder=""${minMaxAttrs}${attrs} onblur="validateRange(this)" oninput="markParamAsModified(this)" style="flex: 1;">`;
                }

                paramsHtml += `
                    <div class="param-item-row" id="param_row_${targetInst.key}_${pName}">
                        <div class="param-name-label" title="${pName}">${pVal.label || pName}</div>
                        <div class="param-actions">
                            ${inputHtml}
                            <span class="unit-label">${pVal.unit || ''}</span>
                            <button class="btn-secondary btn-sm" title="Read" onclick="event.stopPropagation();readParam('${targetInst.key}','${pName}')">🔍</button>
                            <button class="btn-secondary btn-sm" title="Write" ${isSettable ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'} onclick="event.stopPropagation();setParam('${targetInst.key}','${pName}')">✏️</button>
                            <button class="btn-secondary btn-sm" title="Add" onclick="event.stopPropagation();toggleAddSpecificParamRow('${targetInst.key}', '${pName}', '${fullKey}')">➕</button>
                        </div>
                    </div>`;
            });

            targetCard.innerHTML = `
                <div class="instrument-header" onclick="this.parentElement.classList.toggle('expanded')">
                    <span class="instrument-title">${targetInst.key}</span>
                    <div style="display: flex; align-items: center; gap: 8px;">
						<button class="btn-secondary btn-sm" title="Remove Instrument" onclick="event.stopPropagation(); toggleRemoveInstrumentRow('${targetInst.key}')">➖</button>
                    </div>
                </div>
                <div class="instrument-body"><div class="param-list-container">${paramsHtml || '<div style="color:var(--muted);font-size:.8rem;text-align:center;padding:6px 0;">No parameters</div>'}</div></div>`;
            targetCard.classList.add('expanded');
        }

        updateScanAxisDropdowns();
        populateCustomDropdown();
        initTextInputTooltips();
    } catch (err) {
        console.error("Failed to reload single instrument:", err);
    }
}

function toggleAddSpecificParamRow(instKey, pName, paramFullName) {
    const rowId = `inlineAddParamRow_${instKey}_${pName}`;
    let existingRow = document.getElementById(rowId);
    if (existingRow) { existingRow.remove(); return; }
    const paramRow = document.getElementById(`param_row_${instKey}_${pName}`);
    if (!paramRow) return;

    const inlineRow = document.createElement('div');
    inlineRow.id = rowId;
    inlineRow.style.cssText = 'display: flex; gap: 6px; align-items: center; padding: 6px 8px; background: #f8fafc; border: 1px dashed var(--primary, #6366f1); border-radius: 4px; margin-top: 4px; margin-bottom: 4px; flex: 1;';
    inlineRow.innerHTML = `
        <span style="font-weight: 600; color: var(--secondary);">Unified Name:</span>
        <input type="text" id="inlineParamNameInput_${instKey}_${pName}" value="${pName}" class="table-input" style="flex: 1; min-width: 80px;" autocomplete="off">
        <button class="btn-primary btn-sm" onclick="confirmAddSpecificParam('${instKey}', '${pName}', '${paramFullName}')">Confirm</button>
        <button class="btn-secondary btn-sm" onclick="document.getElementById('${rowId}').remove()">Cancel</button>
    `;
    paramRow.insertAdjacentElement('afterend', inlineRow);
    const inputEl = document.getElementById(`inlineParamNameInput_${instKey}_${pName}`);
    if (inputEl) { inputEl.focus(); inputEl.select(); }
}

async function confirmAddSpecificParam(instKey, pName, paramFullName) {
    const inputEl = document.getElementById(`inlineParamNameInput_${instKey}_${pName}`);
    if (!inputEl) return;
    const customName = inputEl.value.trim();
    if (!customName) { alert('Parameter name cannot be empty!'); return; }
    try {
        await apiPost('/api/station/add_parameter', { name: customName, sourceStr: paramFullName });
        document.getElementById(`inlineAddParamRow_${instKey}_${pName}`)?.remove();
        await fetchParametersJson();
    } catch (err) { alert('Failed to add parameter: ' + err.message); }
}

window.toggleAddSpecificParamRow = toggleAddSpecificParamRow;
window.confirmAddSpecificParam = confirmAddSpecificParam;

async function fetchParametersJson() {
    try {
        const data = await apiPost('/api/station/get_paras_in_station', {});
        fillUnifiedParametersTable(data);
        updateScanAxisDropdowns();
        populateCustomDropdown();
        return data;
    } catch (_) { return null; }
}

function fillUnifiedParametersTable(data) {
    const tbody = document.getElementById('unifiedParametersTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!data || !Object.keys(data).length) {
        tbody.innerHTML = '<div style="color:var(--muted);font-size:.8rem;text-align:center;padding:10px 0;">No parameters configured.</div>';
        return;
    }

    for (let [paramKey, paramObj] of Object.entries(data)) {
        const tr = document.createElement('tr');
        tr.setAttribute('data-param-name', paramKey);
        const sourceVal = paramObj.src_name || '', valContent = paramObj.value;
        const minValue = paramObj.min_value ?? '', maxValue = paramObj.max_value ?? '', step = paramObj.step ?? '', interDelay = paramObj.inter_delay ?? '';
        const rampRate = paramObj.metadata?.ramp_rate ?? '', rampRateUnit = paramObj.metadata?.ramp_rate_unit ?? '';
        const acquireChecked = paramObj.metadata?.acquire_in_scan ? 'checked' : '', isSettable = paramObj.settable !== false;
        const safeInputId = 'unified_input_' + sourceVal.replace(/[\.\_\s]/g, '_');
        const guiMeta = paramObj.metadata, isEnum = guiMeta.type === 'enum';
        const isDropdown = isEnum || guiMeta.type === 'parameter' || paramObj.metadata?.type === 'parameter';

        let inputHtml = '';
        if (isDropdown) {
            let optionsHtml = isEnum && Array.isArray(guiMeta.values) ? guiMeta.values.map(val => `<option value="${val}" ${val === valContent ? 'selected' : ''}>${val}</option>`).join('') : getAllParametersOptionsHtml(valContent);
            const attrs = isSettable ? '' : 'disabled style="background-color: var(--bg-disabled, #f1f5f9); color: var(--muted, #94a3b8); cursor: not-allowed;"';
            inputHtml = `<select id="${safeInputId}" class="table-input" style="width: 140px;" ${attrs} oninput="markParamAsModified(this)">${optionsHtml}</select>`;
        } else if (Array.isArray(valContent)) {
            const is2DArray = valContent.length > 0 && Array.isArray(valContent[0]);
            const attrs = isSettable ? '' : 'readonly style="background-color: var(--bg-disabled, #f1f5f9); color: var(--muted, #94a3b8); cursor: not-allowed;"';
            if (is2DArray) {
                let matrixHtml = `<div class="matrix-inputs-container" data-unified-array="${safeInputId}" style="display: flex; flex-direction: column; gap: 4px; width: 160px;">`;
                valContent.forEach((rowItem, rIdx) => {
                    matrixHtml += `<div style="display: flex; gap: 4px; align-items: center; flex: 1;"><span style="font-size: 0.7rem; color: var(--muted); min-width: 16px;">[${rIdx}]</span>`;
                    if (Array.isArray(rowItem)) {
                        rowItem.forEach((colItem, cIdx) => {
                            const isNumeric = typeof colItem === 'number', cellVal = colItem ?? '';
                            matrixHtml += `<input type="${isNumeric ? 'number' : 'text'}" class="table-input matrix-cell" data-row="${rIdx}" data-col="${cIdx}" value="${cellVal}" title="${cellVal}" ${isNumeric ? 'step="any"' : ''} ${attrs} style="flex: 1; min-width: 30px;" oninput="this.title=this.value; markParamAsModified(this)">`;
                        });
                    }
                    matrixHtml += `</div>`;
                });
                inputHtml = matrixHtml + `</div>`;
            } else {
                const isNumericArray = valContent.length > 0 && typeof valContent[0] === 'number', inputType = isNumericArray ? 'number' : 'text';
                let arrayInputsHtml = `<div class="array-inputs-container" data-unified-array="${safeInputId}" style="display: flex; flex-direction: column; gap: 4px; width: 140px;">`;
                valContent.forEach((item, idx) => {
                    const itemVal = item ?? '';
                    arrayInputsHtml += `<div style="display: flex; align-items: center; gap: 4px;"><span style="font-size: 0.7rem; color: var(--muted); min-width: 16px;">[${idx}]</span><input type="${inputType}" class="table-input" value="${itemVal}" title="${itemVal}" ${inputType === 'number' ? 'step="any"' : ''} ${attrs} style="flex: 1;" oninput="this.title=this.value; markParamAsModified(this)"></div>`;
                });
                inputHtml = arrayInputsHtml + `</div>`;
            }
        } else if (valContent !== null && typeof valContent === 'object' && !Array.isArray(valContent)) {
            const attrs = isSettable ? '' : 'readonly style="background-color: var(--bg-disabled, #f1f5f9); color: var(--muted, #94a3b8); cursor: not-allowed;"';
            let dictInputsHtml = `<div class="dict-inputs-container" data-unified-dict="${safeInputId}" style="display: flex; flex-direction: column; gap: 4px; width: 160px;">`;
            Object.entries(valContent).forEach(([dictKey, dictVal]) => {
                const isNumeric = (typeof dictVal === 'number' && !isNaN(dictVal)) || (dictVal !== '' && !isNaN(Number(dictVal)));
                const dVal = dictVal ?? '';
                dictInputsHtml += `<div style="display: flex; align-items: center; gap: 4px;"><span style="font-size: 0.7rem; color: var(--muted); max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${dictKey}">${dictKey}:</span><input type="${isNumeric ? 'number' : 'text'}" class="table-input" data-dict-key="${dictKey}" value="${dVal}" title="${dVal}" ${isNumeric ? 'step="any"' : ''} ${attrs} style="flex: 1;" oninput="this.title=this.value; markParamAsModified(this)"></div>`;
            });
            inputHtml = dictInputsHtml + `</div>`;
        } else {
            const hasMin = paramObj.min_value != null, hasMax = paramObj.max_value != null;
            const minMaxAttrs = (hasMin ? ` min="${paramObj.min_value}"` : '') + (hasMax ? ` max="${paramObj.max_value}"` : '');
            const attrs = isSettable ? '' : 'readonly style="background-color: var(--bg-disabled, #f1f5f9); color: var(--muted, #94a3b8); cursor: not-allowed;"';
            const vContent = valContent ?? '', inputType = (typeof valContent === 'number' || hasMin || hasMax) ? 'number' : 'text';
            let tooltipAttr = `title="${vContent}"`;
            if (inputType === 'number') {
                tooltipAttr = `title="min: ${hasMin ? paramObj.min_value : 'None'} | max: ${hasMax ? paramObj.max_value : 'None'} | step: ${paramObj.step ?? 'None'} | interdelay: ${paramObj.inter_delay ?? 'None'}"`;
            }
            inputHtml = `<input type="${inputType}" id="${safeInputId}" value="${vContent}" ${tooltipAttr} class="table-input" style="width: 90px;"${minMaxAttrs}${attrs} onblur="validateRange(this)" oninput="markParamAsModified(this)">`;
        }

        tr.innerHTML = `
            <td style="text-align: center;"><input type="checkbox" class="acquire-in-scan-checkbox" ${acquireChecked} style="width: 12px; height: 12px; accent-color: var(--primary);" oninput="markParamAsModified(this)"></td>
            <td>
				<div class=\"cell-row-single\">
					<span style="color:var(--secondary); font-weight:700" title=\"${sourceVal}\">${paramKey}</span>
					<div style="display: flex; align-items: center; gap: 4px;">${inputHtml}</div>
					<span class="unit-label">${paramObj.unit || ''}</span>
				</div>
			</td>
            <td>
				<div class=\"cell-row-single\">
						<span>Limits </span>
						<input type="number" class="limit-min-input" value="${minValue}" placeholder="--" step="any" title="Lower limit" oninput="markParamAsModified(this)">
						<span>-</span>
						<input type="number" class="limit-max-input" value="${maxValue}" placeholder="--" step="any" title="Upper limit"  oninput="markParamAsModified(this)">
				</div>
			</td>
            <td>
				<div class=\"cell-row-single\">
						<span>Soft rate </span>
						<input type="number" class="soft-rate-step-input" value="${step}" placeholder="--" step="any" title="step" oninput="markParamAsModified(this)">
						<span>/</span>
						<input type="number" class="soft-rate-delay-input" value="${interDelay}" placeholder="--" step="any" title="inter_delay" oninput="markParamAsModified(this)">
				</div>
			</td>
            <td>
				<div class=\"cell-row-single\">
						<span>Instr rate </span>
						<input type="number" class="instr-rate-input" value="${rampRate}" placeholder="--" step="any" title="Companion instrument ramp rate (if available)" oninput="markParamAsModified(this)">
						<span class="unit-label ramp-rate-unit-label">${rampRateUnit}</span>

				</div>
			</td>
            <td>
				<div class=\"cell-row-single\">
					<button class="btn-secondary btn-sm" onclick="readUnifiedParam('${sourceVal}')">🔍</button>
					<button class="btn-secondary btn-sm" ${isSettable ? '' : 'disabled style="opacity:0.5;cursor:not-allowed;"'} onclick="setUnifiedParam('${sourceVal}')">✏️</button>
					<button class="btn-secondary btn-sm" onclick="removeUnifiedParam('${paramKey}', this.closest('tr'))">➖</button>
				</div>
			</td>`;
        tbody.appendChild(tr);
    }
    initTextInputTooltips();
}

function removeUnifiedParam(paramName, trElement) {
    const rowId = `inlineRemoveParamRow_${paramName.replace(/[\.\_\s]/g, '_')}`;
    let existingRow = document.getElementById(rowId);
    if (existingRow) { existingRow.remove(); return; }

    const inlineRow = document.createElement('tr');
    inlineRow.id = rowId;
    inlineRow.innerHTML = `<td colspan="6" style="padding: 6px 12px; background: #fef2f2; border: 1px dashed #ef4444;"><div style="display: flex; align-items: center; justify-content: space-between; flex: 1;"><span style="font-size: 0.8rem; font-weight: 600; color: #dc2626;">Remove parameter "${paramName}"?</span><div style="display: flex; gap: 6px;"><button class="btn-danger btn-sm" style="padding: 2px 8px; background: #dc2626; color: white; border: none; border-radius: 4px; cursor: pointer;" onclick="confirmRemoveUnifiedParam('${paramName}', this.closest('tr'))">Confirm</button><button class="btn-secondary btn-sm" style="padding: 2px 8px;" onclick="document.getElementById('${rowId}').remove()">Cancel</button></div></div></td>`;
    trElement.insertAdjacentElement('afterend', inlineRow);
}

async function confirmRemoveUnifiedParam(paramName, rowElement) {
    try {
        await apiPost('/api/station/remove_parameter', { name: paramName });
        rowElement.previousElementSibling?.remove();
        rowElement.remove();
        await fetchParametersJson();
        updateScanAxisDropdowns();
        const tbody = document.getElementById('unifiedParametersTableBody');
        if (tbody && !tbody.querySelector('tr')) tbody.innerHTML = '<div style="color:var(--muted);font-size:.8rem;text-align:center;padding:10px 0;">No parameters configured.</div>';
    } catch (err) { alert('Failed: ' + err.message); }
}

window.removeUnifiedParam = removeUnifiedParam;
window.confirmRemoveUnifiedParam = confirmRemoveUnifiedParam;

async function readUnifiedParam(sourceName) {
    try {
        const res = await apiPost('/api/station/get_instrument_parameter', { parameter: sourceName, updt_gui_meta: true });
        if (res !== null && res !== undefined) {
            const val = (typeof res === 'object' && res.value !== undefined) ? res.value : res;
            const safeId = 'unified_input_' + sourceName.replace(/[\.\_\s]/g, '_');
            const el = document.getElementById(safeId);
            if (el) { el.value = val; 
				el.classList.remove('dirty-input');
				delete el.dataset.modified;
			}

            const parentTr = el?.closest('tr');
            if (parentTr) {
                if (res.metadata?.acquire_in_scan !== undefined) parentTr.querySelector('.acquire-in-scan-checkbox').checked = Boolean(res.metadata.acquire_in_scan);
                if (res.unit !== undefined) parentTr.querySelector('.unit-label').textContent = res.unit;
                if (res.min_value !== undefined) parentTr.querySelector('.limit-min-input').value = res.min_value ?? '';
                if (res.max_value !== undefined) parentTr.querySelector('.limit-max-input').value = res.max_value ?? '';
                if (res.step !== undefined) parentTr.querySelector('.soft-rate-step-input').value = res.step ?? '';
                if (res.inter_delay !== undefined) parentTr.querySelector('.soft-rate-delay-input').value = res.inter_delay ?? '';
                if (res.metadata?.ramp_rate !== undefined) parentTr.querySelector('.instr-rate-input').value = res.metadata.ramp_rate ?? '';
                if (res.metadata?.ramp_rate_unit !== undefined) parentTr.querySelector('.ramp-rate-unit-label').textContent = res.metadata.ramp_rate_unit ?? '';
                if (el && el.type === 'number') {
                    el.title = `min: ${res.min_value ?? 'None'} | max: ${res.max_value ?? 'None'} | step: ${res.step ?? 'None'} | interdelay: ${res.inter_delay ?? 'None'}`;
                }
				parentTr.querySelectorAll('.dirty-input').forEach(dom => {
					dom.classList.remove('dirty-input');
					delete dom.dataset.modified;
				});
            }
        }
    } catch (err) { alert('Read failed: ' + err.message); }
}

async function setUnifiedParam(sourceName) {
    const safeId = 'unified_input_' + sourceName.replace(/[\.\_\s]/g, '_');
    const el = document.getElementById(safeId), matrixContainer = document.querySelector(`[data-unified-array="${safeId}"].matrix-inputs-container`);
    const arrayContainer = document.querySelector(`[data-unified-array="${safeId}"]`), dictContainer = document.querySelector(`[data-unified-dict="${safeId}"]`);
    let valueToSend = '';

    if (el) {
        if (el.tagName !== 'SELECT' && el.value !== '') validateRange(el);
        valueToSend = parseInputValue(el);
    } else if (matrixContainer) {
        valueToSend = [];
        matrixContainer.querySelectorAll('div[style*="display: flex"]').forEach(rowDiv => {
            const cellInputs = rowDiv.querySelectorAll('input.matrix-cell');
            if (cellInputs.length > 0) valueToSend.push(Array.from(cellInputs).map(inp => { const v = inp.value; return (v !== '' && !isNaN(Number(v))) ? Number(v) : v; }));
        });
    } else if (arrayContainer) {
        valueToSend = Array.from(arrayContainer.querySelectorAll('input')).map(inp => { const v = inp.value; return (v !== '' && !isNaN(Number(v))) ? Number(v) : v; });
    } else if (dictContainer) {
        valueToSend = {};
        dictContainer.querySelectorAll('input').forEach(inp => {
            const dictKey = inp.getAttribute('data-dict-key');
            if (dictKey) { const v = inp.value; valueToSend[dictKey] = (v !== '' && !isNaN(Number(v))) ? Number(v) : v; }
        });
    }

    const parentTr = (el || matrixContainer || arrayContainer || dictContainer)?.closest('tr');
    const getValFromInput = (selector) => { const input = parentTr?.querySelector(selector); return input && input.value !== '' ? parseFloat(input.value) : null; };

    try {
        await apiPost('/api/station/set_instrument_parameter', {
            parameter: sourceName, value: valueToSend, set_meta: true,
            min_value: getValFromInput('.limit-min-input'), max_value: getValFromInput('.limit-max-input'),
            step: getValFromInput('.soft-rate-step-input'), inter_delay: getValFromInput('.soft-rate-delay-input'),
            ramp_rate: getValFromInput('.instr-rate-input'), acquire_in_scan: parentTr?.querySelector('.acquire-in-scan-checkbox')?.checked ?? false
        });
        await readUnifiedParam(sourceName);
    } catch (err) { alert('Set failed: ' + err.message); }
}

function updateScanAxisDropdowns() {
    const xSelect = document.getElementById('xScanSelect'), ySelect = document.getElementById('yScanSelect');
    if (!xSelect && !ySelect) return;
    let settableParams = [];

    document.querySelectorAll('#unifiedParametersTableBody tr').forEach(tr => {
        const name = tr.querySelector('td:nth-child(2) span')?.innerText.trim(), src = tr.querySelector('td:nth-child(2) span')?.title.trim();
        if (name && src) {
            const [instKey, pName] = src.split('.');
            if (globalInstrumentsCache.find(i => i.key === instKey)?.parameters?.[pName]?.settable !== false) {
                settableParams.push({ name, source: src });
            }
        }
    });

    const optionsHtml = settableParams.length ? '<option value="">None (index)</option>' + settableParams.map(p => `<option value="${p.name}">${p.name} (${p.source})</option>`).join('') : '<option value="">No settable parameters</option>';
    if (xSelect) { const val = xSelect.value; xSelect.innerHTML = optionsHtml; xSelect.value = val; }
    if (ySelect) { const val = ySelect.value; ySelect.innerHTML = optionsHtml; ySelect.value = val; }
}

// 标记芯片模块已修改，高亮write按钮
function markChipsDirty() {
    _chipsModified = true;
    const btn = document.getElementById('set_chip_info');
    if(btn) btn.classList.add('btn-highlight-dirty');
}

// 清除芯片模块修改标记，取消高亮
function clearChipsDirty() {
    _chipsModified = false;
    const btn = document.getElementById('set_chip_info');
    if(btn) btn.classList.remove('btn-highlight-dirty');
}

function addNewChipCard() {
    chipsList.push({ id: 'chip_' + Date.now(), name: 'chip-' + (chipsList.length + 1), images: [] });
    markChipsDirty();
	renderChipsContainer();
}

function toggleRemoveChipRow(chipId) {
    const rowId = `inlineRemoveChipRow_${chipId}`;
    let existingRow = document.getElementById(rowId);
    if (existingRow) { existingRow.remove(); return; }

    const targetCard = Array.from(document.querySelectorAll('.sample-card-item')).find(el => el.querySelector(`button[onclick*="${chipId}"]`));
    if (!targetCard) return;

    const inlineRow = document.createElement('div');
    inlineRow.id = rowId;
    inlineRow.style.cssText = 'display: flex; gap: 6px; align-items: center; padding: 8px 12px; background: #fef2f2; border: 1px dashed #ef4444; border-radius: 6px; margin-top: 8px; flex: 1; box-sizing: border-box;';
    inlineRow.innerHTML = `
        <span style="font-size: 0.8rem; font-weight: 600; color: #dc2626;">Remove this chip card?</span>
        <div style="margin-left: auto; display: flex; gap: 6px;">
            <button class="btn-danger btn-sm" style="padding: 2px 8px; background: #dc2626; color: white; border: none; border-radius: 4px; cursor: pointer;" onclick="confirmRemoveChipCard('${chipId}')">Confirm</button>
            <button class="btn-secondary btn-sm" style="padding: 2px 8px;" onclick="document.getElementById('${rowId}').remove()">Cancel</button>
        </div>
    `;
    targetCard.appendChild(inlineRow);
}

function confirmRemoveChipCard(id) {
    chipsList = chipsList.filter(c => c.id !== id);
	markChipsDirty();
    renderChipsContainer();
}

window.toggleRemoveChipRow = toggleRemoveChipRow;
window.confirmRemoveChipCard = confirmRemoveChipCard;

function renderChipsContainer() {
    const container = document.getElementById('chipCardContainer');
    if (!container) return;
    container.innerHTML = chipsList.length ? '' : '<div style="color:var(--muted);font-size:.9rem;text-align:center;padding:16px 0;">No chips added yet.</div>';

    chipsList.forEach((chip, idx) => {
        const div = document.createElement('div');
        div.className = 'sample-card-item';
        
        let imgs = chip.images.length ? chip.images.map((img) => {
            const defaultName = img.name || 'image';
            const displayName = img.customName !== undefined ? img.customName : defaultName;
            
            return `
                <div class="sample-preview-card">
                    <div class="sample-img-container" onclick="openImageModal('${img.url}','${displayName}')">
                        <img src="${img.url}" alt="">
                    </div>
                    <div class="sample-card-footer" style="display: flex; flex-direction: column; gap: 4px; padding: 4px;">
                        <input type="text" value="${displayName}" title="${displayName}" 
                            style="width: 100%; text-align: center;" 
                            placeholder="Image name"
                            oninput="updateImageName('${chip.id}', '${img.imgId}', this.value); markStorageModified(this);">
                        <button class="btn-danger btn-sm" style="flex: 1;" onclick="toggleRemoveChipImageRow('${chip.id}','${img.imgId}')">Del</button>
                    </div>
                </div>`;
        }).join('') : '<div style="color:var(--muted);font-size:.75rem;padding:8px 0;grid-column:1/-1;text-align:center;">No images uploaded.</div>';

        div.innerHTML = `
            <div class="sample-card-header">
                <div style="display:flex;gap:8px;align-items:center;flex:1;max-width:320px;">
                    <label style="font-size:.8rem;font-weight:600;color:var(--muted);">chip #${idx + 1}</label>
                    <input type="text" value="${chip.name}" title="${chip.name}" oninput="chipsList.find(s=>s.id=='${chip.id}').name=this.value; this.title=this.value; markStorageModified(this);" placeholder="Enter chip name">
                </div>
                <div style="display:flex;gap:6px;">
                    <button class="btn-secondary btn-lg" onclick="document.getElementById('fileInput_${chip.id}').click()">Add Image</button>
                    <input type="file" id="fileInput_${chip.id}" style="display:none;" accept="image/*" multiple onchange="handleChipImagesUpload('${chip.id}',event)">
                    <button class="btn-secondary btn-sm" style="background:#faf5ff;border:0;" onclick="toggleRemoveChipRow('${chip.id}')" title="Remove">➖</button>
                </div>
            </div>
            <div class="sample-preview-grid">${imgs}</div>`;
        container.appendChild(div);
    });
    initTextInputTooltips();
}

function updateImageName(chipId, imgId, newName) {
    const chip = chipsList.find(s => s.id === chipId);
    if (!chip) return;
    const img = chip.images.find(i => i.imgId === imgId);
    if (img) {
        img.customName = newName;
    }
}
window.updateImageName = updateImageName;

function toggleRemoveChipImageRow(chipId, imgId) {
    const rowId = `inlineRemoveImgRow_${chipId}_${imgId}`;
    let existingRow = document.getElementById(rowId);
    if (existingRow) { existingRow.remove(); return; }

    const targetCard = Array.from(document.querySelectorAll('.sample-preview-card')).find(el => el.querySelector(`button[onclick*="${imgId}"]`));
    if (!targetCard) return;

    const inlineRow = document.createElement('div');
    inlineRow.id = rowId;
    inlineRow.style.cssText = 'position: absolute; inset: 0; background: rgba(254, 242, 242, 0.95); border: 1px dashed #ef4444; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 8px; z-index: 10; box-sizing: border-box;';
    inlineRow.innerHTML = `
        <span style="font-weight: 600; color: #dc2626; text-align: center;">Delete this image?</span>
        <div style="display: flex; gap: 6px;">
            <button class="btn-danger btn-sm" style="padding: 2px 8px; font-size: 0.7rem; background: #dc2626; color: white; border: none; border-radius: 4px; cursor: pointer;" onclick="removeChipImage('${chipId}','${imgId}')">Confirm</button>
            <button class="btn-secondary btn-sm" style="padding: 2px 8px; font-size: 0.7rem;" onclick="document.getElementById('${rowId}').remove()">Cancel</button>
        </div>
    `;
    targetCard.style.position = 'relative';
    targetCard.appendChild(inlineRow);
}

window.toggleRemoveChipImageRow = toggleRemoveChipImageRow;

function handleChipImagesUpload(id, e) {
    const chip = chipsList.find(s => s.id === id);
    if (!chip || !e.target.files.length) return;
    Array.from(e.target.files).forEach(file => {
        const reader = new FileReader();
        reader.onload = (ev) => {
            chip.images.push({ imgId: 'img_' + Date.now(), name: file.name, url: ev.target.result });
            markChipsDirty();
			renderChipsContainer();
        };
        reader.readAsDataURL(file);
    });
}

function removeChipImage(chipId, imgId) {
    const chip = chipsList.find(s => s.id === chipId);
    if (chip) { chip.images = chip.images.filter(img => img.imgId !== imgId); markChipsDirty(); renderChipsContainer(); }
}

async function setChipCards() {
    try {
        await apiPost('/api/scan/set_chip_conf', { chipsList });
        // ✅ set成功之后自动调用read
        await getChipCards();
    } catch (err) {
        alert('Failed to update chip information: ' + err.message);
    }
}
window.setChipCards = setChipCards;

async function getChipCards() {
    try {
        const data = await apiPost('/api/scan/get_chip_conf', {});
        if (data && Array.isArray(data.chipsList)) {
            chipsList = data.chipsList;
        } else if (Array.isArray(data)) {
            chipsList = data;
        }
		clearChipsDirty();
        renderChipsContainer();
    } catch (err) {
        alert('Failed to retrieve chip information: ' + err.message);
    }
}
window.getChipCards = getChipCards;

function setScanDefaultValues() {
    ['xStart', 'xStop', 'xPoints', 'xDelay', 'yStart', 'yStop', 'yPoints', 'yDelay'].forEach((id, i) => {
        const el = document.getElementById(id);
        if (el) el.value = Object.values(DEFAULT_CONFIG)[i + 5];
    });
}

function getCurrentScanConfig() {
    const getVal = (id) => document.getElementById(id)?.value ?? '';
    return {
        scanBwd: document.getElementById('scanBwd')?.checked,
        scanCts: document.getElementById('scanCts')?.checked,
        xParam: document.getElementById('xScanSelect')?.value || '',
        xValues: [parseFloat(getVal('xStart')), parseFloat(getVal('xStop')), parseInt(getVal('xPoints')), parseFloat(getVal('xDelay'))],
        yParam: document.getElementById('yScanSelect')?.value || '',
        yValues: [parseFloat(getVal('yStart')), parseFloat(getVal('yStop')), parseInt(getVal('yPoints')), parseFloat(getVal('yDelay'))]
    };
}

async function loadQueueFromBackend() {
    try {
        // 查询，POST，body空对象
        const data = await apiPost('/api/scan/get_queue', {});
        const globalScanStatus = data.status ?? "Idle";
        scanQueue = (data.queue || data || []).map(t => ({ ...t, status: t.status || 'Idle' }));
        const statusEl = document.getElementById("scanStatusText");
        if (statusEl) {
            statusEl.textContent = globalScanStatus;
            statusEl.className = "status-badge";
            const s = globalScanStatus.toLowerCase();
            const map = {
                idle: "idle",
                running: "running",
                paused: "paused",
                stopped: "stopped",
                error: "error"
            };
            const cls = map[s] ?? "error";
            statusEl.classList.add(cls);
        }
        renderScanQueue(globalScanStatus);
        return globalScanStatus;
    } catch (_) {
        // 轮询静默失败，不弹窗
    }
}

/**
 * 公共扫描配置校验函数
 * @param {object} config getCurrentScanConfig返回的对象
 * @returns {{ok:boolean, msg:string}} ok=true代表校验通过
 */
function validateScanConfig(config) {
    const [xStart, xStop, xPoints, xDelay] = config.xValues;
    if (isNaN(xStart) || isNaN(xStop) || isNaN(xPoints) || isNaN(xDelay) || xPoints <= 0 || xDelay < 0) {
        return { ok: false, msg: "❌ X‑scan 参数非法：Start/Stop/Points/Delay不能为空，Points>0，Delay不能为负数" };
    }
    if (config.yParam) {
        const [yStart, yStop, yPoints, yDelay] = config.yValues;
        if (isNaN(yStart) || isNaN(yStop) || isNaN(yPoints) || isNaN(yDelay) || yPoints <= 0 || yDelay < 0) {
            return { ok: false, msg: "❌ Y‑scan 参数非法：Start/Stop/Points/Delay不能为空，Points>0，Delay不能为负数" };
        }
    }
    return { ok: true, msg: "" };
}

async function addCurrentToQueue() {
    try {
        const config = getCurrentScanConfig();
        // const check = validateScanConfig(config);
        //if (!check.ok) {
          //  alert(check.msg);
          //  return;
        //}
        await apiPost('/api/scan/add_to_queue', config);
        await loadQueueFromBackend();
    } catch (err) {
        alert('❌ Error adding to queue');
    }
}

async function startQueueExecution() {
    try {
        if (scanQueue.length === 0) {
            // Add‑and‑run场景：队列为空，把当前配置加入队列，先做校验
            const config = getCurrentScanConfig();
            // const check = validateScanConfig(config);
            // if (!check.ok) {
                // alert(check.msg);
                // return;
            // }
            await apiPost('/api/scan/add_to_queue', config);
        }
        await apiPost('/api/scan/start_queue', {});
		startScanStatusPoll();
    } catch (err) {
        alert(err.message);
    }
}


async function clearScanQueue() {
    await apiPost('/api/scan/clear_queue', {});
    loadQueueFromBackend();
}

function renderScanQueue(globalScanStatus = "Idle") {
    const tbody = document.getElementById('scanQueueTableBody');
    if (!tbody) return;
    tbody.innerHTML = scanQueue.length
        ? ''
        : '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:14px;">No scan tasks in queue</td></tr>';
    scanQueue.forEach((item, i) => {
        const isRunningItem = item.status && (item.status.includes('Running') || item.status.includes('Executing'));
        const xValStr = Array.isArray(item.xValues) ? item.xValues.join(', ') : item.xValues;
        const yValStr = Array.isArray(item.yValues) ? item.yValues.join(', ') : item.yValues;
        const delBtnDisabled = isRunningItem ? 'disabled' : '';
        const delBtnStyle = isRunningItem ? 'style="opacity:0.4;cursor:not-allowed;"' : '';
        tbody.innerHTML += `
<tr style="${isRunningItem ? 'background:#f3e8ff;' : ''}">
    <td style="font-weight:500;">${i + 1}</td>
    <td>X: ${item.xParam || 'None'}, ${xValStr}</td>
    <td>Y: ${item.yParam || 'None'}, ${yValStr}</td>
    <td style="text-align:center;">Bwd: ${item.scanBwd ? '✅' : '❌'}</td>
    <td style="text-align:center;">Cts: ${item.scanCts ? '✅' : '❌'}</td>
    <td>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <span style="color:${isRunningItem ? 'var(--primary)' : 'var(--text)'}; font-weight:600;">${item.status}</span>
            <button class="btn-secondary btn-sm" title="Remove" ${delBtnDisabled} ${delBtnStyle} onclick="deleteQueueItem(${i})">➖</button>
        </div>
    </td>
</tr>`;
    });

    const runQueueBtn = document.getElementById('startQueueBtn');
    const pauseResumeToggleBtn = document.getElementById('pauseResumeToggleBtn');
    const stopQueueBtn = document.getElementById('stopQueueBtn');

    const status = (globalScanStatus ?? 'idle').toLowerCase();
    const isActuallyRunning = ["running"].includes(status);
    const isPaused = ["paused"].includes(status);
    const isStoppedState = ["idle", "stopped", "error"].includes(status);

    if (runQueueBtn) {
        runQueueBtn.textContent = scanQueue.length === 0 ? '▶ Add and run' : '▶ Run Queue';
        runQueueBtn.disabled = !isStoppedState;
        runQueueBtn.style.opacity = isStoppedState ? '1' : '0.5';
        runQueueBtn.style.cursor = isStoppedState ? 'pointer' : 'not-allowed';
    }

    if (pauseResumeToggleBtn) {
        if (isActuallyRunning) {
            pauseResumeToggleBtn.textContent = "⏸ Pause";
            pauseResumeToggleBtn.disabled = false;
            pauseResumeToggleBtn.onclick = togglePauseResume;
        } else if (isPaused) {
            pauseResumeToggleBtn.textContent = "▶ Resume";
            pauseResumeToggleBtn.disabled = false;
            pauseResumeToggleBtn.onclick = togglePauseResume;
        } else {
            pauseResumeToggleBtn.textContent = "⏸ Pause";
            pauseResumeToggleBtn.disabled = true;
            pauseResumeToggleBtn.onclick = null;
        }
    }

    if (stopQueueBtn) {
        stopQueueBtn.disabled = !(isActuallyRunning || isPaused);
    }
}

async function moveQueueItem(index, direction) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= scanQueue.length) return;
    const temp = scanQueue[index];
    scanQueue[index] = scanQueue[targetIndex];
    scanQueue[targetIndex] = temp;
    renderScanQueue();
}

async function deleteQueueItem(index) {
    try {
        await apiPost('/api/scan/remove_scan_from_queue', { index });
        await loadQueueFromBackend();
    } catch (err) { alert('❌ Error removing task: ' + err.message); }
}



async function togglePauseResume() {
    try {
        await apiPost('/api/scan/pause', {});
    } catch (err) {
        console.error("Pause/Resume toggle error:", err);
    }
    await loadQueueFromBackend();
}
window.togglePauseResume = togglePauseResume;

async function stopQueueExecution() {
    try { await apiPost('/api/scan/stop', {}); } catch (err) { console.error("Stop error:", err); }
    await loadQueueFromBackend();
}

async function pollScanStatus() {
    try {	
		const state = await loadQueueFromBackend();
		await fetchHeaderLog();
		const isRunning = state === "Stopping" || state === "Pausing" || state === "Paused" || state === "Resuming" || state === "Running";
        if (!isRunning) {
            stopScanStatusPoll();
        }
    } catch(err) {
        console.error("poll scan status error:", err);
    }
}

// 开启轮询：立刻执行一次，之后每1s跑一次
function startScanStatusPoll() {
    if (scanStatusPollTimer !== null) return;
    pollScanStatus();
    scanStatusPollTimer = setInterval(pollScanStatus, 200);
}

// 停止轮询
function stopScanStatusPoll() {
    if (scanStatusPollTimer !== null) {
        clearInterval(scanStatusPollTimer);
        scanStatusPollTimer = null;
    }
}


function triggerImportConfig() {
    let fileInput = document.getElementById('hiddenImportFileInput');
    if (!fileInput) {
        fileInput = document.createElement('input');
        fileInput.id = 'hiddenImportFileInput';
        fileInput.type = 'file';
        fileInput.accept = '.json';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', async (e) => {
            if (!e.target.files.length) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    await apiPost('/api/station/import_config', JSON.parse(event.target.result));
                    await loadSettings();
                    await getStationInstruments();
                    await fetchParametersJson();
                } catch (err) { alert('Failed to import config: ' + err.message); }
            };
            reader.readAsText(e.target.files[0]);
            fileInput.value = '';
        });
        document.body.appendChild(fileInput);
    }
    fileInput.click();
}

function exportConfigFile() {
    let inlineRow = document.getElementById('inlineExportConfigRow');
    if (inlineRow) { inlineRow.remove(); return; }
    const container = document.getElementById('instrumentGrid');
    if (!container) return;

    inlineRow = document.createElement('div');
    inlineRow.id = 'inlineExportConfigRow';
    inlineRow.style.cssText = 'display: flex; gap: 8px; align-items: center; padding: 10px; background: #f8fafc; border: 1px dashed var(--primary, #6366f1); border-radius: 6px; margin-bottom: 12px; grid-column: 1 / -1;';
    inlineRow.innerHTML = `
        <span style="font-size: 0.8rem; font-weight: 600; color: var(--secondary);">Path</span>
        <input type="text" id="inlineExportPath" value="station_config.json" class="table-input" style="flex: 2;" autocomplete="off" placeholder="Enter file path or name...">
        <button class="btn-primary btn-sm" onclick="confirmExportConfig()">Confirm</button>
        <button class="btn-secondary btn-sm" onclick="document.getElementById('inlineExportConfigRow').remove()">Cancel</button>
    `;
    container.insertBefore(inlineRow, container.firstChild);
    document.getElementById('inlineExportPath')?.focus();
}


async function confirmExportConfig() {
    const pathInput = document.getElementById('inlineExportPath');
    if (!pathInput) return;
    try {
        await apiPost('/api/station/export_config', { path: pathInput.value.trim() || 'station_config.json' });
        document.getElementById('inlineExportConfigRow')?.remove();
    } catch (err) { alert('Failed to save config: ' + err.message); }
}

window.triggerImportConfig = triggerImportConfig;
window.exportConfigFile = exportConfigFile;
window.confirmExportConfig = confirmExportConfig;

// ========== Header 日志轮询 ==========
async function fetchHeaderLog() {
    const el = document.getElementById('headerLogOutput');
    if (!el) return;
    try {
        const data = await apiPost('/api/station/get_msg', {});
        let msg = (typeof data === 'string') ? data : (data?.msg ?? '');

        function escapeHtml(str) {
            return str
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        // 1. 将字符串中的 \n、文本形式 <br>、<br/> 替换为唯一占位符
        const BR_PLACE = `\u0001__BR__\u0001`;
        let temp = msg
            .replace(/\r?\n/g, BR_PLACE)
            .replace(/<br\s*\/?>/gi, BR_PLACE);

        // 2. 整体做HTML转义（XSS防护）
        let safe = escapeHtml(temp);

        // 3. 占位符替换为真实HTML <br>
        safe = safe.replace(new RegExp(BR_PLACE, "g"), "<br>");

        el.innerHTML = safe;
        el.title = msg;
    } catch (_) {
        const el = document.getElementById('headerLogOutput');
        if(el) el.innerHTML = "";
    }
}

window.fetchHeaderLog = fetchHeaderLog;

window.onload = () => {
    loadQueueFromBackend();
    setScanDefaultValues();
    loadSettings();
    getStationInstruments();
    fetchParametersJson();
    getChipCards();
    initTextInputTooltips();
	fetchHeaderLog();
};