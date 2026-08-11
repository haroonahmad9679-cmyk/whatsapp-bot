/* script.js - Harry Chatbot Ai */

// TAB SWITCHING LOGIC (Handles both Sidebar and Mobile Nav)
document.querySelectorAll('.sb-item, .mn-item').forEach(btn => {
  btn.onclick = () => {
    // Remove active from all nav items
    document.querySelectorAll('.sb-item, .mn-item').forEach(b => b.classList.remove('active'));
    // Hide all tab panes
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    
    // Add active to clicked nav item
    btn.classList.add('active');
    
    // Sync sidebar and mobile nav if they share the same data-tab
    const tabId = btn.dataset.tab;
    document.querySelectorAll(`[data-tab="${tabId}"]`).forEach(b => b.classList.add('active'));
    
    // Show correct tab pane
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
    const res = await fetch('/api/stats');
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
    const res = await fetch('/api/chats');
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
      nameSpan.textContent = (c.name && c.name.trim() !== '') ? c.name : c.phone_number;
      
      const previewSpan = document.createElement('span');
      previewSpan.className = 'contact-preview';
      previewSpan.textContent = c.last_message || '...';
      
      li.appendChild(nameSpan);
      li.appendChild(previewSpan);
      li.onclick = () => loadChat(c.phone_number, li, nameSpan.textContent);
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
    const res = await fetch(`/api/chats/${number}`);
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

  await fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: currentNumber, message: msg })
  });
};

document.getElementById('manual-message').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('send-btn').click();
});

// TAB 3: CONTACTS CRM
async function fetchCRMContacts() {
  const res = await fetch('/api/contacts');
  const data = await res.json();
  const tbody = document.querySelector('#contacts-table tbody');
  tbody.innerHTML = '';
  data.forEach(c => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${c.phone_number}</strong></td>
      <td><input type="text" value="${c.name || ''}" id="name-${c.phone_number}" placeholder="Add Name"></td>
      <td><input type="text" value="${c.notes || ''}" id="notes-${c.phone_number}" placeholder="Add Notes"></td>
      <td><button onclick="saveContact('${c.phone_number}')">Save</button></td>
    `;
    tbody.appendChild(tr);
  });
}
window.saveContact = async (phone) => {
  const name = document.getElementById(`name-${phone}`).value;
  const notes = document.getElementById(`notes-${phone}`).value;
  await fetch('/api/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number: phone, name, notes })
  });
  alert('Contact Saved!');
};

// TAB 4: APPOINTMENTS
async function fetchAppointments() {
  const res = await fetch('/api/appointments');
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
  
  await fetch('/api/appointments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number: phone, appointment_date: new Date(date).toISOString(), reason })
  });
  alert('Appointment Scheduled! AI Reminder enabled.');
  document.getElementById('appointment-form').reset();
  fetchAppointments();
};

// TAB 5: SETTINGS
async function fetchSettings() {
  const res = await fetch('/api/settings');
  const data = await res.json();
  document.getElementById('setting-prompt').value = data.system_prompt;
}
document.getElementById('settings-form').onsubmit = async (e) => {
  e.preventDefault();
  const prompt = document.getElementById('setting-prompt').value;
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system_prompt: prompt })
  });
  alert('Settings Saved!');
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

// Init
loadTabData('tab-dashboard');
