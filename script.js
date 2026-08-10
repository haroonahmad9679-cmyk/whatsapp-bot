let currentNumber = null;

async function fetchContacts() {
  try {
    const res = await fetch('/api/chats');
    const contacts = await res.json();
    const list = document.getElementById('contact-list');
    
    // Remember currently selected to not lose active state
    list.innerHTML = '';
    
    if (contacts.length === 0) {
       list.innerHTML = '<li style="padding: 20px; color: #666; text-align: center;">No chats yet</li>';
       return;
    }

    contacts.forEach(c => {
      const li = document.createElement('li');
      li.className = 'contact-item';
      if (c.phone_number === currentNumber) li.classList.add('active');
      li.textContent = c.phone_number;
      li.onclick = () => loadChat(c.phone_number, li);
      list.appendChild(li);
    });
  } catch (e) {
    console.error("Failed to fetch contacts", e);
  }
}

async function loadChat(number, element) {
  currentNumber = number;
  
  // Update active class
  document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));
  if (element) {
    element.classList.add('active');
  } else {
    // If element is null (from polling), try to find it
    const items = document.querySelectorAll('.contact-item');
    items.forEach(el => {
      if (el.textContent === number) el.classList.add('active');
    });
  }
  
  document.getElementById('current-contact').textContent = `Chat with ${number}`;
  document.getElementById('manual-message').disabled = false;
  document.getElementById('send-btn').disabled = false;

  try {
    const res = await fetch(`/api/chats/${number}`);
    const messages = await res.json();
    
    const history = document.getElementById('chat-history');
    
    // Simple check to prevent scrolling if no new messages
    if (history.children.length === messages.length) return; 

    history.innerHTML = '';
    messages.forEach(m => {
      const div = document.createElement('div');
      div.className = `message ${m.direction}`;
      div.textContent = m.message;
      history.appendChild(div);
    });
    
    // Scroll to bottom
    history.scrollTop = history.scrollHeight;
  } catch (e) {
    console.error("Failed to fetch chat", e);
  }
}

document.getElementById('send-btn').onclick = async () => {
  const input = document.getElementById('manual-message');
  const msg = input.value.trim();
  if (!msg || !currentNumber) return;
  
  input.value = '';
  
  // Optimistically add to UI
  const history = document.getElementById('chat-history');
  const div = document.createElement('div');
  div.className = `message manual`;
  div.textContent = msg;
  history.appendChild(div);
  history.scrollTop = history.scrollHeight;

  try {
    await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: currentNumber, message: msg })
    });
  } catch (e) {
    console.error("Failed to send", e);
    div.textContent = "Failed to send: " + msg;
    div.style.background = "#ff3333";
  }
};

// Handle Enter key
document.getElementById('manual-message').addEventListener('keypress', function (e) {
  if (e.key === 'Enter') {
    document.getElementById('send-btn').click();
  }
});

// Poll for new messages every 3 seconds
setInterval(() => {
  fetchContacts();
  if (currentNumber) {
    loadChat(currentNumber, null);
  }
}, 3000);

// Initial load
fetchContacts();
