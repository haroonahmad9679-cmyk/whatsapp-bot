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
    const res = await apiFetch('/api/stats');
    if (!res) return;
    const data = await res.json();
    document.getElementById('stat-messages').textContent = data.total_messages;
    document.getElementById('stat-contacts').textContent = data.total_contacts;
    document.getElementById('stat-appointments').textContent = data.total_appointments;
  } catch (e) {}
}

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
      li.onclick = () => loadChat(c.phone_number, li, nameSpan.textContent.replace('HOT LEAD 🔥', '').trim());
      list.appendChild(li);
    });
  } catch (e) {}
}

async function loadChat(number, element, displayName) {
  currentNumber = number;
  document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));
  if (element) element.classList.add('active');
  
  document.getElementById('current-contact').textContent = `Chat with ${displayName}`;
  document.getElementById('manual-message').disabled = false;
  document.getElementById('send-btn').disabled = false;

  try {
    const res = await apiFetch(`/api/chats/${number}`);
    const messages = await res.json();
    const history = document.getElementById('chat-history');
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
    alert("Failed to send message! Your Meta WhatsApp Token may have expired. Please check your Render logs.");
  }
};

document.getElementById('manual-message').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('send-btn').click();
});

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
  document.getElementById('setting-prompt').value = data.system_prompt;
}
document.getElementById('settings-form').onsubmit = async (e) => {
  e.preventDefault();
  const prompt = document.getElementById('setting-prompt').value;
  await apiFetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system_prompt: prompt })
  });
  alert('Settings Saved!');
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
