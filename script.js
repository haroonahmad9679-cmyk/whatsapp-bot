/* script.js - Harry Chatbot Ai */

let authToken = localStorage.getItem('harry_bot_token');

// AUTH FLOW
const loginOverlay = document.getElementById('login-overlay');
const appContainer = document.getElementById('app');

if (authToken) {
  loginOverlay.style.display = 'none';
  appContainer.style.display = 'flex';
  loadTabData('tab-dashboard');
}

document.getElementById('login-form').onsubmit = async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    if (res.ok) {
      const data = await res.json();
      authToken = data.token;
      localStorage.setItem('harry_bot_token', authToken);
      loginOverlay.style.display = 'none';
      appContainer.style.display = 'flex';
      loadTabData('tab-dashboard');
    } else {
      alert("Invalid credentials. Try admin@harry.com / password123");
    }
  } catch (err) {
    alert("Login failed.");
  }
};

document.getElementById('show-register').onclick = (e) => {
  e.preventDefault();
  document.getElementById('login-view').style.display = 'none';
  document.getElementById('register-view').style.display = 'block';
};

document.getElementById('show-login').onclick = (e) => {
  e.preventDefault();
  document.getElementById('register-view').style.display = 'none';
  document.getElementById('login-view').style.display = 'block';
};

document.getElementById('register-form').onsubmit = async (e) => {
  e.preventDefault();
  const company_name = document.getElementById('reg-company').value;
  const email = document.getElementById('reg-email').value;
  const password = document.getElementById('reg-password').value;
  
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name, email, password })
    });
    
    if (res.ok) {
      const data = await res.json();
      authToken = data.token;
      localStorage.setItem('harry_bot_token', authToken);
      loginOverlay.style.display = 'none';
      appContainer.style.display = 'flex';
      loadTabData('tab-dashboard');
    } else if (res.status === 409) {
      alert("An account with this email already exists.");
    } else {
      alert("Registration failed. Please check your inputs.");
    }
  } catch (err) {
    alert("Registration failed.");
  }
};

// API WRAPPER TO INJECT JWT
async function apiFetch(url, options = {}) {
  if (!authToken) return null;
  const headers = { ...options.headers, 'Authorization': `Bearer ${authToken}` };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem('harry_bot_token');
    window.location.reload();
  }
  return res;
}

// TAB SWITCHING LOGIC
document.querySelectorAll('.sb-item, .mn-item').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.sb-item, .mn-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    
    btn.classList.add('active');
    const tabId = btn.dataset.tab;
    document.querySelectorAll(`[data-tab="${tabId}"]`).forEach(b => b.classList.add('active'));
    
    const pane = document.getElementById(tabId);
    if(pane) pane.classList.add('active');
    
    loadTabData(tabId);
  };
});

function loadTabData(tabId) {
  if (tabId === 'tab-dashboard') fetchStats();
  if (tabId === 'tab-inbox') fetchInboxContacts();
  if (tabId === 'tab-contacts') fetchCRMContacts();
  if (tabId === 'tab-appointments') fetchAppointments();
  if (tabId === 'tab-settings') fetchSettings();
}

// TAB 1: DASHBOARD
async function fetchStats() {
  try {
    const res = await apiFetch('/api/analytics');
    if (!res) return;
    const data = await res.json();
    document.getElementById('stat-messages').textContent = data.totalMessages;
    document.getElementById('stat-hotleads').textContent = data.hotLeads;
    if (document.getElementById('stat-visitors')) {
       document.getElementById('stat-visitors').textContent = data.totalVisitors;
    }
    
    const cRes = await apiFetch('/api/stats');
    if (cRes) {
       const cData = await cRes.json();
       document.getElementById('stat-contacts').textContent = cData.total_contacts;
    }
    
    if (window.activityChartInstance) window.activityChartInstance.destroy();
    
    const ctx = document.getElementById('activityChart').getContext('2d');
    const labels = data.activity.map(a => new Date(a.date).toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'}));
    const counts = data.activity.map(a => a.count);
    
    window.activityChartInstance = new Chart(ctx, {
      type: 'bar',
      data: { 
        labels, 
        datasets: [{ 
          label: 'Messages', 
          data: counts, 
          backgroundColor: '#00f0ff', // Cyber Neon Cyan
          borderColor: '#00f0ff',
          borderWidth: 1,
          borderRadius: 4,
          hoverBackgroundColor: '#ff00ff', // Cyber Neon Magenta on hover
          hoverBorderColor: '#ff00ff'
        }] 
      },
      options: { 
        responsive: true, 
        onClick: async (e, elements) => {
          if (elements.length > 0) {
            const index = elements[0].index;
            const rawDate = data.activity[index].date;
            const formattedDate = new Date(rawDate).toISOString().split('T')[0];
            
            document.getElementById('analytics-modal').style.display = 'flex';
            document.getElementById('analytics-modal-title').textContent = `Activity for ${labels[index]}`;
            document.getElementById('analytics-modal-content').innerHTML = '<p style="text-align:center; color:#9ca3af;">Loading...</p>';
            
            try {
              const res = await apiFetch(`/api/analytics/date?date=${formattedDate}`);
              const msgs = await res.json();
              
              if (msgs.length === 0) {
                 document.getElementById('analytics-modal-content').innerHTML = '<p style="text-align:center; color:#9ca3af;">No activity recorded.</p>';
                 return;
              }
              
              let html = '<div style="display:flex; flex-direction:column; gap:12px;">';
              msgs.forEach(m => {
                 const badge = m.lead_score === 'Hot' ? '<span class="badge-hot" style="background:rgba(239,68,68,0.2); color:#ef4444; border:1px solid rgba(239,68,68,0.3); font-size:10px; padding:2px 6px; border-radius:12px; margin-left:8px;">HOT</span>' : '';
                 const name = m.name || m.phone_number;
                 const dirColor = m.direction === 'inbound' ? '#10b981' : '#00f0ff';
                 const dirIcon = m.direction === 'inbound' ? 'fa-arrow-down' : 'fa-arrow-up';
                 const time = new Date(m.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                 
                 html += `
                   <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 12px; border-radius: 8px;">
                     <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                       <strong style="color:#fff;">${name} ${badge}</strong>
                       <span style="color:#9ca3af; font-size:12px;"><i class="fa-solid ${dirIcon}" style="color:${dirColor}"></i> ${time}</span>
                     </div>
                     <p style="color:#d1d5db; margin:0; font-size:14px; white-space:pre-wrap;">${m.message}</p>
                   </div>
                 `;
               });
               html += '</div>';
               document.getElementById('analytics-modal-content').innerHTML = html;
            } catch(e) {
               document.getElementById('analytics-modal-content').innerHTML = '<p style="text-align:center; color:#ef4444;">Error loading data.</p>';
            }
          }
        },
        plugins: { 
          legend: { display: false } 
        }, 
        scales: { 
          y: { 
            beginAtZero: true, 
            ticks: { precision: 0, color: '#9ca3af' },
            grid: { color: 'rgba(255, 255, 255, 0.05)' }
          },
          x: {
            ticks: { color: '#9ca3af' },
            grid: { display: false }
          }
        } 
      }
    });
  } catch (e) { console.error(e); }
}

// LOGOUT BUTTON
document.getElementById('logout-btn').onclick = () => {
  localStorage.removeItem('harry_bot_token');
  window.location.reload();
};

// TAB 2: INBOX
let currentNumber = null;
async function fetchInboxContacts() {
  try {
    const res = await apiFetch('/api/chats');
    if (!res) return;
    const contacts = await res.json();
    const list = document.getElementById('contact-list');
    list.innerHTML = '';
    
    if (contacts.length === 0) {
       list.innerHTML = '<li style="padding: 20px; color: var(--text-3); text-align: center;">No chats yet</li>';
       return;
    }
    
    contacts.forEach(c => {
      const li = document.createElement('li');
      li.className = 'contact-item';
      if (c.phone_number === currentNumber) li.classList.add('active');
      
      const nameSpan = document.createElement('span');
      nameSpan.className = 'contact-name';
      
      let badge = "";
      if (c.lead_score === 'Hot') badge = ' <span class="badge-hot">HOT LEAD 🔥</span>';
      else if (c.lead_score === 'Warm') badge = ' <span class="badge-warm">Warm</span>';
      
      nameSpan.innerHTML = ((c.name && c.name.trim() !== '') ? c.name : c.phone_number) + badge;
      
      const previewSpan = document.createElement('span');
      previewSpan.className = 'contact-preview';
      previewSpan.textContent = c.last_message || '...';
      
      li.appendChild(nameSpan);
      li.appendChild(previewSpan);
      li.onclick = () => loadChat(c.phone_number, li, nameSpan.textContent.replace('HOT LEAD 🔥', '').trim(), c.bot_active);
      list.appendChild(li);
    });
  } catch (e) {}
}

async function loadChat(number, element, displayName, botActive) {
  currentNumber = number;
  document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));
  if (element) element.classList.add('active');
  
  document.getElementById('current-contact').textContent = `Chat with ${displayName}`;
  document.getElementById('manual-message').disabled = false;
  document.getElementById('send-btn').disabled = false;
  const tplBtn = document.getElementById('open-template-modal-btn');
  if (tplBtn) tplBtn.disabled = false;
  
  const toggleContainer = document.getElementById('ai-toggle-container');
  toggleContainer.style.display = 'flex';
  
  const toggleBtn = document.getElementById('toggle-ai-btn');
  toggleBtn.checked = botActive === undefined ? true : botActive;
  toggleBtn.onchange = async () => {
     await apiFetch(`/api/contacts/${number}/toggle-ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bot_active: toggleBtn.checked })
     });
     
     if (element) {
        element.onclick = () => loadChat(number, element, displayName, toggleBtn.checked);
     }
  };

  try {
    const res = await apiFetch(`/api/chats/${number}`);
    const messages = await res.json();
    const history = document.getElementById('chat-history');
    
    // Check 24-hour window status
    const warningBanner = document.getElementById('window-warning-banner');
    if (messages && messages.length > 0) {
      const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound');
      if (lastInbound && lastInbound.timestamp) {
        const lastTime = new Date(lastInbound.timestamp).getTime();
        const diffHours = (Date.now() - lastTime) / (1000 * 60 * 60);
        if (diffHours >= 24 && warningBanner) {
          warningBanner.style.display = 'flex';
        } else if (warningBanner) {
          warningBanner.style.display = 'none';
        }
      }
    }

    if (history.children.length === messages.length) return; 

    history.innerHTML = '';
    messages.forEach(m => {
      const div = document.createElement('div');
      div.className = `message ${m.direction}`;
      div.textContent = m.message;
      history.appendChild(div);
    });
    history.scrollTop = history.scrollHeight;
  } catch (e) {}
}

document.getElementById('send-btn').onclick = async () => {
  const input = document.getElementById('manual-message');
  const msg = input.value.trim();
  if (!msg || !currentNumber) return;
  input.value = '';
  
  const history = document.getElementById('chat-history');
  const div = document.createElement('div');
  div.className = `message manual`;
  div.textContent = msg;
  history.appendChild(div);
  history.scrollTop = history.scrollHeight;

  const res = await apiFetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: currentNumber, message: msg })
  });
  
  if (res && !res.ok) {
    const errData = await res.json().catch(() => ({}));
    if (errData.is_window_expired || errData.code === 131047) {
      const banner = document.getElementById('window-warning-banner');
      if (banner) banner.style.display = 'flex';
      alert("⚠️ 24-Hour Window Expired: WhatsApp blocks free-form text messages after 24 hours of customer inactivity.\n\nPlease click the '⚡ Template' button to re-engage this customer with an approved Meta Template!");
    } else {
      alert("Failed to send message: " + (errData.error || "Please check your Meta WhatsApp Token in Settings."));
    }
  }
};

document.getElementById('manual-message').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('send-btn').click();
});

// TEMPLATE MODAL HANDLERS
let defaultTemplateName = 'hello_world';
let defaultTemplateLang = 'en_US';

function openTemplateModal() {
  if (!currentNumber) {
    alert("Please select a contact from the inbox first.");
    return;
  }
  document.getElementById('tpl-phone').value = currentNumber;
  document.getElementById('tpl-name').value = defaultTemplateName || 'hello_world';
  document.getElementById('tpl-lang').value = defaultTemplateLang || 'en_US';
  document.getElementById('tpl-var').value = '';
  document.getElementById('template-status-msg').style.display = 'none';
  document.getElementById('template-modal').style.display = 'flex';
}

const openTplBtn = document.getElementById('open-template-modal-btn');
if (openTplBtn) openTplBtn.onclick = openTemplateModal;

const bannerTplBtn = document.getElementById('banner-open-template-btn');
if (bannerTplBtn) bannerTplBtn.onclick = openTemplateModal;

const closeTplBtn = document.getElementById('close-template-modal-btn');
if (closeTplBtn) closeTplBtn.onclick = () => { document.getElementById('template-modal').style.display = 'none'; };

document.getElementById('send-template-form').onsubmit = async (e) => {
  e.preventDefault();
  const to = document.getElementById('tpl-phone').value;
  const template_name = document.getElementById('tpl-name').value.trim();
  const language_code = document.getElementById('tpl-lang').value.trim();
  const body_variable = document.getElementById('tpl-var').value.trim();
  const statusElem = document.getElementById('template-status-msg');
  const submitBtn = document.getElementById('send-template-submit-btn');

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';

  try {
    const res = await apiFetch('/api/send-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, template_name, language_code, body_variable })
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      statusElem.style.display = 'block';
      statusElem.style.background = 'rgba(16,185,129,0.15)';
      statusElem.style.color = '#10b981';
      statusElem.style.border = '1px solid rgba(16,185,129,0.3)';
      statusElem.textContent = '✅ Template message sent successfully!';

      // Append to local chat
      const history = document.getElementById('chat-history');
      const div = document.createElement('div');
      div.className = `message manual`;
      div.textContent = `📋 [Template: ${template_name}] ${body_variable ? '(' + body_variable + ')' : ''}`;
      history.appendChild(div);
      history.scrollTop = history.scrollHeight;

      const banner = document.getElementById('window-warning-banner');
      if (banner) banner.style.display = 'none';

      setTimeout(() => {
        document.getElementById('template-modal').style.display = 'none';
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send Template Message';
      }, 1500);
    } else {
      statusElem.style.display = 'block';
      statusElem.style.background = 'rgba(239,68,68,0.15)';
      statusElem.style.color = '#ef4444';
      statusElem.style.border = '1px solid rgba(239,68,68,0.3)';
      statusElem.textContent = '❌ Failed: ' + (data.error || 'Meta API rejected the template. Check template name and language.');
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send Template Message';
    }
  } catch (err) {
    statusElem.style.display = 'block';
    statusElem.style.color = '#ef4444';
    statusElem.textContent = '❌ Connection error.';
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send Template Message';
  }
};

// TAB 3: CONTACTS CRM
async function fetchCRMContacts() {
  const res = await apiFetch('/api/contacts');
  if (!res) return;
  const data = await res.json();
  const tbody = document.querySelector('#contacts-table tbody');
  tbody.innerHTML = '';
  data.forEach(c => {
    let badgeClass = 'badge-cold';
    let badgeIcon = '';
    if (c.lead_score === 'Hot') { badgeClass = 'badge-hot'; badgeIcon = '🔥'; }
    if (c.lead_score === 'Warm') badgeClass = 'badge-warm';
    
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${c.phone_number}</strong></td>
      <td><input type="text" value="${c.name || ''}" id="name-${c.phone_number}" placeholder="Add Name"></td>
      <td><span class="${badgeClass}">${c.lead_score || 'Cold'} ${badgeIcon}</span></td>
      <td><input type="text" value="${c.notes || ''}" id="notes-${c.phone_number}" placeholder="Add Notes"></td>
      <td><button onclick="saveContact('${c.phone_number}')">Save</button></td>
    `;
    tbody.appendChild(tr);
  });
}
window.saveContact = async (phone) => {
  const name = document.getElementById(`name-${phone}`).value;
  const notes = document.getElementById(`notes-${phone}`).value;
  await apiFetch('/api/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number: phone, name, notes }) // Note: lead_score is not updated manually here for simplicity
  });
  alert('Contact Saved!');
};

// TAB 4: APPOINTMENTS
async function fetchAppointments() {
  const res = await apiFetch('/api/appointments');
  if (!res) return;
  const data = await res.json();
  const list = document.getElementById('appointment-list');
  list.innerHTML = '';
  data.forEach(a => {
    const li = document.createElement('li');
    const dateStr = new Date(a.appointment_date).toLocaleString();
    const sentBadge = a.reminder_sent 
      ? '<span class="badge">Reminder Sent <i class="fa-solid fa-check"></i></span>' 
      : '<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;border-color:rgba(245,158,11,0.2);">Pending AI</span>';
    li.innerHTML = `<div><strong style="color:#fff;">${a.phone_number}</strong> - <span style="color:var(--text-2);">${a.reason}</span><br><small style="color:var(--text-3); margin-top:4px; display:block;"><i class="fa-regular fa-clock"></i> ${dateStr}</small></div> ${sentBadge}`;
    list.appendChild(li);
  });
}
document.getElementById('appointment-form').onsubmit = async (e) => {
  e.preventDefault();
  const phone = document.getElementById('appt-phone').value;
  const date = document.getElementById('appt-date').value; 
  const reason = document.getElementById('appt-reason').value;
  
  await apiFetch('/api/appointments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number: phone, appointment_date: new Date(date).toISOString(), reason })
  });
  alert('Appointment Scheduled! AI Reminder enabled.');
  document.getElementById('appointment-form').reset();
  fetchAppointments();
};

// TAB 5: SETTINGS & KNOWLEDGE BASE
async function fetchSettings() {
  const res = await apiFetch('/api/settings');
  if (!res) return;
  const data = await res.json();
  document.getElementById('setting-prompt').value = data.system_prompt || '';
  
  if (data.whatsapp_token) {
    document.getElementById('setting-wa-token').value = data.whatsapp_token;
    const badge = document.getElementById('token-status-badge');
    if (badge) {
      badge.innerHTML = '<i class="fa-solid fa-key" style="color:#60a5fa;"></i> Token Stored';
      badge.style.borderColor = 'rgba(59,130,246,0.3)';
    }
  }
  if (data.whatsapp_phone_id) {
    document.getElementById('setting-phone-id').value = data.whatsapp_phone_id;
  }
  if (data.default_template_name) {
    document.getElementById('setting-tpl-name').value = data.default_template_name;
    defaultTemplateName = data.default_template_name;
  }
  if (data.default_template_lang) {
    document.getElementById('setting-tpl-lang').value = data.default_template_lang;
    defaultTemplateLang = data.default_template_lang;
  }
  if (data.meta_app_id) {
    const metaInput = document.getElementById('setting-meta-app-id');
    if (metaInput) metaInput.value = data.meta_app_id;
    const onboardInput = document.getElementById('meta-app-id-input');
    if (onboardInput) onboardInput.value = data.meta_app_id;
  }
}

// Toggle token visibility
document.getElementById('toggle-token-visibility').onclick = () => {
  const input = document.getElementById('setting-wa-token');
  const icon = document.querySelector('#toggle-token-visibility i');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'fa-solid fa-eye-slash';
  } else {
    input.type = 'password';
    icon.className = 'fa-solid fa-eye';
  }
};

// WhatsApp Settings Form
document.getElementById('whatsapp-settings-form').onsubmit = async (e) => {
  e.preventDefault();
  const token = document.getElementById('setting-wa-token').value.trim();
  const phoneId = document.getElementById('setting-phone-id').value.trim();
  const tplName = document.getElementById('setting-tpl-name').value.trim();
  const tplLang = document.getElementById('setting-tpl-lang').value.trim();
  const metaAppId = document.getElementById('setting-meta-app-id') ? document.getElementById('setting-meta-app-id').value.trim() : '';
  const statusElem = document.getElementById('wa-settings-status');

  try {
    const res = await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        whatsapp_token: token,
        whatsapp_phone_id: phoneId,
        default_template_name: tplName,
        default_template_lang: tplLang,
        meta_app_id: metaAppId
      })
    });

    if (res.ok) {
      defaultTemplateName = tplName || 'hello_world';
      defaultTemplateLang = tplLang || 'en_US';
      const onboardInput = document.getElementById('meta-app-id-input');
      if (onboardInput && metaAppId) onboardInput.value = metaAppId;

      statusElem.style.display = 'block';
      statusElem.style.color = '#10b981';
      statusElem.textContent = '✅ WhatsApp API settings and templates saved successfully!';
      setTimeout(() => { statusElem.style.display = 'none'; }, 4000);
    } else {
      statusElem.style.display = 'block';
      statusElem.style.color = '#ef4444';
      statusElem.textContent = '❌ Failed to save settings.';
    }
  } catch (err) {
    statusElem.style.display = 'block';
    statusElem.style.color = '#ef4444';
    statusElem.textContent = '❌ Network error.';
  }
};

// Check Coexistence Status Button
const verifyCoexBtn = document.getElementById('verify-coexistence-status-btn');
if (verifyCoexBtn) {
  verifyCoexBtn.onclick = () => {
    document.getElementById('test-token-btn').click();
  };
}

// Meta Embedded Signup Onboarding Launcher
const launchOnboardBtn = document.getElementById('launch-embedded-signup-btn');
if (launchOnboardBtn) {
  launchOnboardBtn.onclick = async () => {
    const appIdInput = document.getElementById('meta-app-id-input');
    const appId = appIdInput ? appIdInput.value.trim() : '';
    const statusDiv = document.getElementById('embedded-signup-status');

    if (!appId) {
      alert("⚠️ Meta App ID Required:\n\nPlease enter your Meta App ID (from developers.facebook.com) in the box above to launch official Embedded Signup.\n\nTip: You can also connect immediately via Option 2 using the WhatsApp Business app directly on your phone!");
      if (appIdInput) appIdInput.focus();
      return;
    }

    statusDiv.style.display = 'block';
    statusDiv.style.color = '#60a5fa';
    statusDiv.textContent = '⏳ Loading official Meta SDK...';

    // Load Facebook SDK dynamically if not present
    if (!window.FB) {
      await new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'https://connect.facebook.net/en_US/sdk.js';
        script.async = true;
        script.defer = true;
        script.onload = resolve;
        document.head.appendChild(script);
      });
    }

    try {
      window.FB.init({
        appId: appId,
        cookie: true,
        xfbml: true,
        version: 'v21.0'
      });

      // Listen for message events from Meta's Embedded Signup popup
      const sessionListener = function(event) {
        if (event.origin && event.origin.includes('facebook.com')) {
          try {
            const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
            if (data.type === 'WA_EMBEDDED_SIGNUP') {
              if (data.event === 'FINISH' && data.data) {
                const phoneId = data.data.phone_number_id;
                const wabaId = data.data.waba_id;
                if (phoneId) {
                  document.getElementById('setting-phone-id').value = phoneId;
                  apiFetch('/api/onboarding/save-coexistence', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone_number_id: phoneId, meta_app_id: appId })
                  }).then(() => {
                    document.getElementById('test-token-btn').click();
                  }).catch(() => {});
                }
              }
            }
          } catch(e) {}
        }
      };
      window.removeEventListener('message', sessionListener);
      window.addEventListener('message', sessionListener);

      statusDiv.textContent = '🚀 Opening Meta authorization popup...';

      // Pass standard non-async function callback as required by Meta SDK
      window.FB.login(function(response) {
        if (response && response.authResponse) {
          const code = response.authResponse.code;
          statusDiv.style.color = '#10b981';
          statusDiv.textContent = '✅ Coexistence onboarding authorized by Meta! Testing connection...';

          apiFetch('/api/onboarding/save-coexistence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ meta_app_id: appId, code: code })
          }).then(() => {
            setTimeout(() => {
              document.getElementById('test-token-btn').click();
            }, 1500);
          }).catch(() => {});
        } else {
          statusDiv.style.color = '#f59e0b';
          statusDiv.textContent = 'ℹ️ Onboarding window closed or cancelled.';
        }
      }, {
        scope: 'whatsapp_business_management,whatsapp_business_messaging',
        extras: {
          setup: {},
          featureType: 'whatsapp_business_app_onboarding',
          sessionInfoVersion: '3'
        }
      });

    } catch (err) {
      statusDiv.style.color = '#ef4444';
      statusDiv.textContent = '❌ Failed to initialize Meta SDK: ' + err.message;
    }
  };
}

// Test Token Connection
document.getElementById('test-token-btn').onclick = async () => {
  const btn = document.getElementById('test-token-btn');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testing Meta API...';
  btn.disabled = true;

  const token = document.getElementById('setting-wa-token').value.trim();
  const phoneId = document.getElementById('setting-phone-id').value.trim();
  const badge = document.getElementById('token-status-badge');

  try {
    const res = await apiFetch('/api/test-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, phone_id: phoneId })
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.valid) {
      badge.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#10b981;"></i> Active: ${data.display_phone_number} (Quality: ${data.quality_rating})`;
      badge.style.borderColor = 'rgba(16,185,129,0.3)';
      badge.style.background = 'rgba(16,185,129,0.1)';
      badge.style.color = '#10b981';
      alert(`✅ Meta Cloud API Connection Successful!\n\nPhone: ${data.display_phone_number}\nVerified Name: ${data.verified_name}\nQuality Rating: ${data.quality_rating}\n\nYour API Token is working perfectly.`);
    } else {
      badge.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color:#ef4444;"></i> Invalid Token`;
      badge.style.borderColor = 'rgba(239,68,68,0.3)';
      badge.style.background = 'rgba(239,68,68,0.1)';
      badge.style.color = '#ef4444';
      alert("❌ Token Verification Failed:\n\n" + (data.error || "Meta rejected the access token or phone ID."));
    }
  } catch (err) {
    alert("❌ Error connecting to test endpoint.");
  }

  btn.innerHTML = originalText;
  btn.disabled = false;
};

document.getElementById('settings-form').onsubmit = async (e) => {
  e.preventDefault();
  const prompt = document.getElementById('setting-prompt').value;
  await apiFetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system_prompt: prompt })
  });
  alert('System Prompt Saved!');
};

document.getElementById('pdf-upload-form').onsubmit = async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById('pdf-file');
  if (fileInput.files.length === 0) return;
  
  const formData = new FormData();
  formData.append('pdfFile', fileInput.files[0]);
  
  const btn = document.getElementById('pdf-upload-btn');
  const originalText = btn.textContent;
  btn.textContent = 'Uploading...';
  btn.disabled = true;
  
  try {
    const res = await apiFetch('/api/upload-pdf', {
      method: 'POST',
      body: formData // Note: When using FormData, do not set 'Content-Type' header, browser does it automatically with boundaries
    });
    
    if (res && res.ok) {
      document.getElementById('pdf-upload-status').style.display = 'block';
      setTimeout(() => { document.getElementById('pdf-upload-status').style.display = 'none'; }, 5000);
      fileInput.value = '';
    } else {
      alert("Failed to upload PDF.");
    }
  } catch (err) {
    alert("Upload error.");
  }
  
  btn.textContent = originalText;
  btn.disabled = false;
};

// Polling for Inbox
setInterval(() => {
  if (document.getElementById('tab-inbox').classList.contains('active')) {
    fetchInboxContacts();
    if (currentNumber) {
      const nameElem = document.getElementById('current-contact');
      loadChat(currentNumber, null, nameElem.textContent.replace('Chat with ', ''));
    }
  }
}, 3000);

// -----------------------------------------
// VISITORS MODAL LOGIC
// -----------------------------------------
async function fetchVisitorData() {
  document.getElementById('visitors-modal').style.display = 'flex';
  document.getElementById('visitors-modal-content').innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px; color:#9ca3af;">Loading...</td></tr>';
  
  try {
    const res = await apiFetch('/api/visitors');
    const data = await res.json();
    
    if (data.length === 0) {
      document.getElementById('visitors-modal-content').innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px; color:#9ca3af;">No visitors recorded yet.</td></tr>';
      return;
    }
    
    let html = '';
    data.forEach(v => {
      const dateStr = new Date(v.visited_at).toLocaleString();
      html += `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
          <td style="padding: 12px; font-size: 14px;">${dateStr}</td>
          <td style="padding: 12px; font-size: 14px; font-family: monospace; color: #f59e0b;">${v.ip_address}</td>
          <td style="padding: 12px; font-size: 12px; color: #9ca3af;">${v.user_agent}</td>
        </tr>
      `;
    });
    document.getElementById('visitors-modal-content').innerHTML = html;
  } catch(e) {
    document.getElementById('visitors-modal-content').innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px; color:#ef4444;">Failed to load data.</td></tr>';
  }
}
