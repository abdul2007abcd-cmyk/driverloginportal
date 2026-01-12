
import { supabase } from './supabaseClient';

// --- Business Constants ---
const CITY_RATE = 150;
const CITY_MIN_HOURS = 4;
const CITY_NIGHT_CHARGE_AMOUNT = 200; // Only if ends >= 22:00
const OUTSTATION_RATE = 1500;
const OUTSTATION_BLOCK_HOURS = 12;

type TripType = 'city' | 'outstation';
type TripStatus = 'pending' | 'started' | 'ended';

interface Trip {
  otp: string;
  trip_type: TripType;
  status: TripStatus;
  driver_id: string;
  start_time: string | null;
  end_time: string | null;
  amount: number | null;
  night_charge: number | null;
}

interface Account {
  username: string;
  role: string;
  created_at?: string;
}

// --- App State ---
let state = {
  view: (localStorage.getItem('app_view') || 'driver') as 'driver' | 'admin',
  adminSubView: 'trips' as 'trips' | 'drivers',
  isAuth: localStorage.getItem('is_auth') === 'true',
  authRole: localStorage.getItem('auth_role') as 'driver' | 'admin' | null,
  authId: localStorage.getItem('auth_id') || '',
  activeTrip: null as Trip | null,
  loading: false,
  isAuthenticating: false,
  tableMissing: false,
  trips: [] as Trip[],
  drivers: [] as Account[],
  error: null as string | null,
  timerInterval: null as number | null
};

/**
 * FIXED CALCULATION LOGIC
 * Bug Fix: Night charges were applying too early or for outstation.
 * Resolution: 
 * 1. City Trip gets ₹200 ONLY if end_time >= 22:00 (Local Time).
 * 2. Outstation Trip night_charge is always 0.
 * 3. Calculation is performed using Date object hour comparison.
 */
function calculateSettlement(t: Trip): { total: number, nightCharge: number } {
  if (!t.start_time || !t.end_time) return { total: 0, nightCharge: 0 };
  
  const start = new Date(t.start_time);
  const end = new Date(t.end_time);
  const diffMs = end.getTime() - start.getTime();
  const hours = diffMs / (1000 * 60 * 60);

  if (t.trip_type === 'city') {
    // 1. Base Fare: 150/hr, Min 4 hrs
    const billableHours = Math.max(CITY_MIN_HOURS, hours);
    const baseFare = billableHours * CITY_RATE;
    
    // 2. Night Charge Rule: ONLY if end_time >= 22:00
    const endHour = end.getHours();
    let nc = 0;
    if (endHour >= 22) {
      nc = CITY_NIGHT_CHARGE_AMOUNT;
    }
    
    return { 
      total: Math.round(baseFare + nc), 
      nightCharge: nc 
    };
  } else {
    // Outstation: ₹1,500 per 12-hour block, 0 night charge
    const blocks = Math.ceil(hours / OUTSTATION_BLOCK_HOURS);
    return { 
      total: blocks * OUTSTATION_RATE, 
      nightCharge: 0 
    };
  }
}

// --- Logic: Operations ---
async function fetchTrips() {
  state.loading = true; render();
  try {
    const { data, error } = await supabase.from('trips').select('*').order('start_time', { ascending: false, nullsFirst: true });
    if (error) {
       if (error.code === '42P01') state.tableMissing = true;
       throw error;
    }
    state.trips = data || [];
    state.error = null;
  } catch (err: any) {
    state.error = "Cloud Sync Error: " + err.message;
  } finally {
    state.loading = false; render();
  }
}

async function fetchDrivers() {
  state.loading = true; render();
  try {
    const { data, error } = await supabase.from('accounts').select('username, role').eq('role', 'driver').order('username');
    if (error) throw error;
    state.drivers = data || [];
  } catch (err: any) {
    state.error = "Account Fetch Error: " + err.message;
  } finally {
    state.loading = false; render();
  }
}

async function startDuty() {
  const digits = [
    (document.getElementById('otp-1') as HTMLInputElement)?.value,
    (document.getElementById('otp-2') as HTMLInputElement)?.value,
    (document.getElementById('otp-3') as HTMLInputElement)?.value,
    (document.getElementById('otp-4') as HTMLInputElement)?.value
  ];
  const otpValue = digits.join('').trim();
  if (otpValue.length < 4) {
    state.error = "Please enter all 4 digits";
    render();
    return;
  }
  state.loading = true; render();
  const { data, error } = await supabase.from('trips')
    .update({ 
      status: 'started', 
      start_time: new Date().toISOString(),
      driver_id: state.authId 
    })
    .match({ otp: otpValue, status: 'pending' })
    .select().single();
  if (error) {
    state.error = "Invalid Code. Please check the OTP.";
  } else {
    state.activeTrip = data;
    state.error = null;
    startTimer();
  }
  state.loading = false; render();
}

async function endDuty() {
  if (!state.activeTrip) return;
  if (!confirm("Confirm Duty Completion?")) return;
  state.loading = true; render();
  const endTime = new Date().toISOString();
  const { total, nightCharge } = calculateSettlement({ ...state.activeTrip, end_time: endTime });
  const { data, error } = await supabase.from('trips')
    .update({ 
      status: 'ended', 
      end_time: endTime, 
      amount: total,
      night_charge: nightCharge
    })
    .eq('otp', state.activeTrip.otp)
    .select().single();
  if (error) state.error = error.message;
  else {
    state.activeTrip = data;
    state.error = null;
  }
  stopTimer();
  state.loading = false; render();
}

// --- Logic: Auth ---
async function handleLogin(e: Event) {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const formData = new FormData(form);
  const username = (formData.get('username') as string || '').trim();
  const password = (formData.get('password') as string || '').trim();
  if (state.view === 'driver' && !username) {
    state.error = "Driver ID is required";
    render();
    return;
  }
  state.isAuthenticating = true;
  state.error = null;
  render();
  try {
    let query = supabase.from('accounts').select('username, password, role');
    if (state.view === 'admin') {
      query = query.eq('role', 'admin').eq('password', password);
    } else {
      query = query.ilike('username', username).eq('role', 'driver').eq('password', password);
    }
    const { data, error } = await query.maybeSingle();
    if (error) {
      if (error.code === '42P01') {
        state.tableMissing = true;
        throw new Error("Missing 'accounts' table.");
      }
      throw error;
    }
    if (data) {
      state.isAuth = true;
      state.authRole = state.view;
      state.authId = data.username;
      state.error = null;
      state.tableMissing = false;
      localStorage.setItem('is_auth', 'true');
      localStorage.setItem('auth_role', state.view);
      localStorage.setItem('auth_id', state.authId);
      if (state.view === 'admin') await fetchTrips();
      else await findActiveDriverTrip();
    } else {
      state.error = `Login Failed: Invalid credentials.`;
    }
  } catch (err: any) {
    state.error = "Auth Error: " + err.message;
  } finally {
    state.isAuthenticating = false;
    render();
  }
}

async function findActiveDriverTrip() {
  try {
    const { data, error } = await supabase
      .from('trips')
      .select('*')
      .eq('status', 'started')
      .eq('driver_id', state.authId)
      .limit(1)
      .maybeSingle();
    if (error && error.code === '42P01') {
      state.tableMissing = true;
      render();
      return;
    }
    if (data) {
      state.activeTrip = data;
      startTimer();
    }
  } catch (err: any) {
    console.warn("Session Recovery Failed", err);
  } finally {
    render();
  }
}

// --- UI Rendering ---
function render() {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = `
    <div class="min-h-screen bg-slate-50 flex flex-col">
      <header class="bg-white border-b border-slate-200 px-4 py-3 sm:px-6 flex justify-between items-center sticky top-0 z-50">
        <div class="flex items-center gap-2">
          <div class="bg-indigo-600 text-white p-1.5 rounded-lg shadow-sm">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          </div>
          <h1 class="text-xs font-black uppercase tracking-widest leading-none">Acting<br/><span class="text-indigo-600">Driver</span></h1>
        </div>
        <div class="flex items-center gap-3">
          ${!state.isAuth ? `
            <button onclick="window.toggleView()" class="text-[9px] font-black uppercase bg-slate-100 text-slate-500 px-3 py-1.5 rounded-full hover:bg-slate-200 transition-all border border-slate-200">
              ${state.view === 'driver' ? 'Admin Portal' : 'Driver Portal'}
            </button>
          ` : `
            <div class="flex items-center gap-2 pr-2 border-r border-slate-200 mr-1">
              <span class="text-[9px] font-black text-slate-400 uppercase tracking-tighter">${state.authId}</span>
            </div>
            <button onclick="window.logout()" class="p-1.5 text-red-400 hover:bg-red-50 rounded-lg transition-colors">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
            </button>
          `}
        </div>
      </header>
      <main class="flex-1 w-full max-w-4xl mx-auto p-4 space-y-6">
        ${state.error && !state.tableMissing ? `
          <div class="bg-red-50 border-l-4 border-red-500 p-4 text-red-700 text-[10px] font-black uppercase flex justify-between items-center rounded-r-lg shadow-sm">
            <div class="flex flex-col">
               <span class="text-red-900 mb-0.5 font-black uppercase tracking-widest">Alert:</span>
               <span>${state.error}</span>
            </div>
            <button onclick="window.clearError()" class="hover:bg-red-100 p-1 rounded">✕</button>
          </div>
        ` : ''}
        ${state.tableMissing ? renderSetupHelp() : 
          state.loading ? `
          <div class="flex flex-col items-center justify-center py-20 space-y-4">
             <div class="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
             <p class="text-[10px] font-black uppercase text-slate-400 tracking-widest">Processing...</p>
          </div>
        ` : (!state.isAuth || state.authRole !== state.view) ? renderLogin() : (state.view === 'driver' ? renderDriverView() : renderAdminView())}
      </main>
    </div>
  `;
  setupListeners();
}

function renderSetupHelp() {
  return `
    <div class="bg-white p-8 rounded-[2.5rem] shadow-xl border-2 border-indigo-200 space-y-6 animate-in zoom-in">
      <div class="flex items-center gap-3 text-indigo-600">
        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        <h2 class="text-xl font-black uppercase tracking-tight">Database Required</h2>
      </div>
      <p class="text-slate-600 text-sm leading-relaxed">Please execute the following SQL in your Supabase Editor to initialize the <code>night_charge</code> column and tables:</p>
      <div class="bg-slate-900 text-emerald-400 p-4 rounded-xl font-mono text-[9px] overflow-x-auto whitespace-pre">
CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, password TEXT, role TEXT);
CREATE TABLE IF NOT EXISTS trips (otp TEXT PRIMARY KEY, trip_type TEXT, status TEXT, driver_id TEXT, start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, amount NUMERIC, night_charge NUMERIC);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS night_charge NUMERIC DEFAULT 0;</div>
      <button onclick="location.reload()" class="w-full bg-slate-900 text-white py-4 rounded-2xl font-black uppercase text-xs tracking-widest hover:bg-indigo-600 transition-colors">Sync & Refresh</button>
    </div>
  `;
}

function renderLogin() {
  const isDriver = state.view === 'driver';
  return `
    <div class="flex flex-col items-center justify-center py-12 space-y-8 animate-in fade-in zoom-in duration-300">
      <div class="text-center space-y-2">
        <h2 class="text-2xl font-black text-slate-900 tracking-tight uppercase">${state.view} Authentication</h2>
        <div class="h-1 w-12 bg-indigo-600 mx-auto rounded-full"></div>
      </div>
      <form id="login-form" class="w-full max-w-sm bg-white p-8 rounded-[2.5rem] shadow-xl shadow-slate-200/50 border border-slate-100 space-y-6">
        <div class="space-y-4">
          ${isDriver ? `
          <div class="space-y-1">
            <label class="text-[9px] font-black uppercase text-slate-400 ml-1 tracking-widest">Driver ID</label>
            <input type="text" name="username" placeholder="RAJ_101" required class="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-4 font-black text-lg outline-none focus:ring-2 focus:ring-indigo-600 transition-all uppercase">
          </div>
          ` : `
          <div class="text-[9px] font-black uppercase text-slate-400 bg-indigo-50 p-3 rounded-xl border border-dashed border-indigo-200 text-center text-indigo-600 font-black">Internal Admin Console</div>
          `}
          <div class="space-y-1">
            <label class="text-[9px] font-black uppercase text-slate-400 ml-1 tracking-widest">Security Key</label>
            <input type="password" name="password" placeholder="••••••••" required class="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-4 font-black text-lg outline-none focus:ring-2 focus:ring-indigo-600 transition-all">
          </div>
        </div>
        <button type="submit" ${state.isAuthenticating ? 'disabled' : ''} class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black py-5 rounded-2xl shadow-lg transition-all active:scale-95 uppercase text-xs tracking-widest disabled:opacity-50">
          ${state.isAuthenticating ? 'Verifying...' : 'Log In'}
        </button>
      </form>
    </div>
  `;
}

function renderDriverView() {
  if (state.activeTrip?.status === 'ended') {
    const t = state.activeTrip;
    const start = new Date(t.start_time!);
    const end = new Date(t.end_time!);
    const diff = end.getTime() - start.getTime();
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    
    const nightCharge = Number(t.night_charge || 0);
    const total = Number(t.amount || 0);
    const baseFare = total - nightCharge;

    return `
      <div class="max-w-md mx-auto space-y-6 animate-in zoom-in duration-500">
        <div class="bg-white rounded-[3rem] shadow-2xl overflow-hidden border border-slate-100">
          <div class="bg-slate-900 p-8 text-center space-y-4">
            <div class="w-16 h-16 bg-emerald-500 text-white rounded-full flex items-center justify-center mx-auto shadow-lg shadow-emerald-500/20">
              <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="M5 13l4 4L19 7"/></svg>
            </div>
            <div>
              <p class="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">Settlement Total</p>
              <h2 class="text-6xl font-black text-white tabular-nums">₹${total}</h2>
            </div>
          </div>
          
          <div class="p-8 space-y-6">
            <div class="grid grid-cols-2 gap-4 pb-6 border-b border-slate-50">
               <div>
                 <p class="text-[8px] font-black text-slate-400 uppercase tracking-widest">Duty Type</p>
                 <p class="text-sm font-black text-indigo-600 uppercase">${t.trip_type}</p>
               </div>
               <div class="text-right">
                 <p class="text-[8px] font-black text-slate-400 uppercase tracking-widest">OTP Code</p>
                 <p class="text-sm font-black text-slate-900">${t.otp}</p>
               </div>
            </div>

            <div class="space-y-4">
               <div class="flex justify-between items-center text-xs">
                 <span class="text-slate-400 font-bold uppercase tracking-widest">Total Duration</span>
                 <span class="text-slate-900 font-black uppercase">${h}h ${m}m</span>
               </div>
               <div class="flex justify-between items-center text-xs">
                 <span class="text-slate-400 font-bold uppercase tracking-widest">Base Fare</span>
                 <span class="text-slate-900 font-black uppercase">₹${baseFare}</span>
               </div>
               ${nightCharge > 0 ? `
               <div class="flex justify-between items-center text-xs">
                 <span class="text-slate-400 font-bold uppercase tracking-widest">Night Charge</span>
                 <span class="text-indigo-600 font-black uppercase">₹${nightCharge}</span>
               </div>
               ` : ''}
            </div>

            <div class="pt-6 border-t border-slate-50 space-y-3">
               <div class="bg-slate-50 p-4 rounded-2xl flex justify-between items-center">
                 <span class="text-[8px] font-black text-slate-400 uppercase tracking-widest">Start</span>
                 <span class="text-[10px] font-black text-slate-900">${start.toLocaleString('en-IN', { hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short' })}</span>
               </div>
               <div class="bg-slate-50 p-4 rounded-2xl flex justify-between items-center">
                 <span class="text-[8px] font-black text-slate-400 uppercase tracking-widest">End</span>
                 <span class="text-[10px] font-black text-slate-900">${end.toLocaleString('en-IN', { hour:'2-digit', minute:'2-digit', day:'2-digit', month:'short' })}</span>
               </div>
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-3">
          <a href="report.html?otp=${t.otp}" target="_blank" class="w-full bg-indigo-600 text-white py-5 rounded-2xl font-black uppercase text-xs tracking-widest shadow-xl shadow-indigo-100 hover:bg-indigo-700 transition-all text-center">Share Full Report</a>
          <button onclick="window.resetDriver()" class="w-full bg-slate-900 text-white py-4 rounded-2xl font-black uppercase text-xs tracking-widest active:scale-95 transition-all">Back to Home</button>
        </div>
      </div>
    `;
  }
  if (state.activeTrip?.status === 'started') {
    return `
      <div class="space-y-6 animate-in slide-in-from-bottom">
        <div class="bg-white p-8 rounded-[2.5rem] shadow-xl shadow-slate-200 border border-slate-100 text-center space-y-6">
          <div class="inline-flex items-center gap-2 px-3 py-1 bg-indigo-50 text-indigo-600 rounded-full text-[9px] font-black uppercase border border-indigo-100 animate-pulse">
            <span class="w-1.5 h-1.5 bg-indigo-600 rounded-full"></span> Live Tracking
          </div>
          <div id="live-timer" class="text-7xl sm:text-8xl font-black text-slate-900 tabular-nums tracking-tighter py-4">00:00:00</div>
          <div class="grid grid-cols-2 gap-4 border-t border-slate-50 pt-6">
            <div class="text-left">
              <p class="text-[8px] font-black text-slate-400 uppercase tracking-widest">Booking OTP</p>
              <p class="text-lg font-black text-indigo-600">${state.activeTrip.otp}</p>
            </div>
            <div class="text-right">
              <p class="text-[8px] font-black text-slate-400 uppercase tracking-widest">Duty Type</p>
              <p class="text-lg font-black text-slate-900 uppercase">${state.activeTrip.trip_type}</p>
            </div>
          </div>
        </div>
        <button onclick="window.endDuty()" class="w-full bg-red-500 hover:bg-red-600 text-white py-6 rounded-3xl font-black uppercase text-sm tracking-widest shadow-xl shadow-red-100 active:scale-95 transition-all">End Duty Session</button>
      </div>
    `;
  }
  return `
    <div class="max-w-md mx-auto animate-in fade-in duration-500">
      <div class="bg-white p-8 sm:p-12 rounded-[3rem] shadow-2xl shadow-indigo-100/50 border border-slate-100 space-y-12 flex flex-col items-center">
        <div class="text-center space-y-3">
          <h2 class="text-2xl font-black text-slate-900 tracking-tight uppercase">Confirm Duty OTP</h2>
          <p class="text-[10px] font-black text-slate-400 uppercase tracking-widest">Enter the code issued by the office</p>
        </div>
        <div class="flex gap-3 sm:gap-4 justify-center" id="otp-container">
          <input type="text" id="otp-1" maxlength="1" inputmode="numeric" oninput="window.otpFocus(1)" onkeydown="window.otpKey(event, 1)" class="w-14 h-16 sm:w-16 sm:h-20 bg-slate-50 border-2 border-slate-100 rounded-2xl text-center font-black text-4xl text-slate-900 outline-none focus:border-indigo-600 focus:bg-white transition-all shadow-sm">
          <input type="text" id="otp-2" maxlength="1" inputmode="numeric" oninput="window.otpFocus(2)" onkeydown="window.otpKey(event, 2)" class="w-14 h-16 sm:w-16 sm:h-20 bg-slate-50 border-2 border-slate-100 rounded-2xl text-center font-black text-4xl text-slate-900 outline-none focus:border-indigo-600 focus:bg-white transition-all shadow-sm">
          <input type="text" id="otp-3" maxlength="1" inputmode="numeric" oninput="window.otpFocus(3)" onkeydown="window.otpKey(event, 3)" class="w-14 h-16 sm:w-16 sm:h-20 bg-slate-50 border-2 border-slate-100 rounded-2xl text-center font-black text-4xl text-slate-900 outline-none focus:border-indigo-600 focus:bg-white transition-all shadow-sm">
          <input type="text" id="otp-4" maxlength="1" inputmode="numeric" oninput="window.otpFocus(4)" onkeydown="window.otpKey(event, 4)" class="w-14 h-16 sm:w-16 sm:h-20 bg-slate-50 border-2 border-slate-100 rounded-2xl text-center font-black text-4xl text-slate-900 outline-none focus:border-indigo-600 focus:bg-white transition-all shadow-sm">
        </div>
        <div class="w-full space-y-4">
          <button onclick="window.startDuty()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black py-5 rounded-[2rem] shadow-xl shadow-indigo-100 transition-all active:scale-[0.98] uppercase text-xs tracking-widest flex items-center justify-center gap-2">Start Duty Trip</button>
        </div>
      </div>
      <p class="mt-12 text-center text-[10px] font-black text-slate-400 uppercase tracking-[0.4em] opacity-40 text-center w-full">Internal Management Network</p>
    </div>
  `;
}

function renderAdminView() {
  return `
    <div class="space-y-8 animate-in fade-in">
      <div class="flex bg-slate-200/50 p-1 rounded-2xl w-full max-w-xs mx-auto">
        <button onclick="window.setAdminSubView('trips')" class="flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${state.adminSubView === 'trips' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-500'}">Log Book</button>
        <button onclick="window.setAdminSubView('drivers')" class="flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${state.adminSubView === 'drivers' ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-500'}">Personnel</button>
      </div>
      ${state.adminSubView === 'trips' ? renderAdminTrips() : renderAdminDrivers()}
    </div>
  `;
}

function renderAdminTrips() {
  return `
    <div class="space-y-8 animate-in slide-in-from-left duration-300">
      <div class="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm space-y-6">
        <h2 class="text-[10px] font-black uppercase tracking-widest text-slate-400">Issue Booking Code</h2>
        <form id="admin-create-form" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
          <div class="space-y-1">
            <label class="text-[8px] font-black text-slate-400 uppercase ml-2 tracking-widest">Duty OTP</label>
            <div class="flex gap-1">
              <input type="text" id="admin-otp" placeholder="0000" class="flex-1 min-w-0 bg-slate-50 border border-slate-200 rounded-xl px-3 py-3 font-black text-center text-sm tabular-nums">
              <button type="button" onclick="window.genOtp()" class="flex-shrink-0 bg-indigo-50 text-indigo-600 px-4 rounded-xl font-black text-[9px] uppercase border border-indigo-100 hover:bg-indigo-100 transition-colors whitespace-nowrap">Auto</button>
            </div>
          </div>
          <div class="space-y-1">
            <label class="text-[8px] font-black text-slate-400 uppercase ml-2 tracking-widest">Assign Driver</label>
            <input type="text" id="admin-driver" placeholder="Optional ID" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-3 font-black text-sm text-center uppercase">
          </div>
          <div class="space-y-1">
            <label class="text-[8px] font-black text-slate-400 uppercase ml-2 tracking-widest">Service Level</label>
            <select id="admin-type" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-3 font-black text-[10px] uppercase cursor-pointer">
              <option value="city">City (₹150/h)</option>
              <option value="outstation">Outstation (₹1500/day)</option>
            </select>
          </div>
          <div class="flex items-end">
            <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-xl font-black uppercase text-[10px] tracking-widest shadow-lg shadow-indigo-100 active:scale-95 transition-all h-[46px]">Issue Code</button>
          </div>
        </form>
      </div>
      <div class="bg-white rounded-[2rem] border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-50 flex justify-between items-center bg-slate-50/30">
          <h2 class="text-[10px] font-black uppercase tracking-widest text-slate-400">Registry Logs</h2>
          <button onclick="window.refreshData()" class="p-2 text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          </button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead><tr class="bg-slate-50/50 text-[9px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-100"><th class="px-6 py-4">OTP</th><th class="px-6 py-4">Driver</th><th class="px-6 py-4">Status</th><th class="px-6 py-4 text-right">Settlement</th><th class="px-6 py-4 text-right">Link</th></tr></thead>
            <tbody class="divide-y divide-slate-50">
              ${state.trips.length === 0 ? '<tr><td colspan="5" class="py-12 text-center text-slate-300 font-black uppercase text-[10px] tracking-widest">No duty logs</td></tr>' : state.trips.map(t => `
                <tr class="text-xs font-bold text-slate-600 hover:bg-slate-50/50 transition-colors">
                  <td class="px-6 py-4 font-black text-slate-900 tabular-nums">${t.otp}</td>
                  <td class="px-6 py-4 font-mono uppercase text-[10px]">${t.driver_id || '—'}</td>
                  <td class="px-6 py-4"><span class="px-2 py-0.5 rounded-md ${t.status === 'started' ? 'bg-indigo-50 text-indigo-600' : t.status === 'ended' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'} uppercase text-[8px] font-black">${t.status}</span></td>
                  <td class="px-6 py-4 text-right text-slate-900 font-black tabular-nums">${t.amount ? `₹${t.amount}` : '—'}</td>
                  <td class="px-6 py-4 text-right">
                    ${t.status === 'ended' ? `<a href="report.html?otp=${t.otp}" target="_blank" class="text-indigo-600 hover:underline text-[9px] uppercase font-black tracking-widest">Report</a>` : '—'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderAdminDrivers() {
  return `
    <div class="space-y-8 animate-in slide-in-from-right duration-300">
      <div class="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm space-y-6">
        <h2 class="text-[10px] font-black uppercase tracking-widest text-slate-400">Add Staff Account</h2>
        <form id="driver-create-form" class="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
          <div class="space-y-1">
            <label class="text-[8px] font-black text-slate-400 uppercase ml-2 tracking-widest">Username</label>
            <input type="text" id="new-driver-id" placeholder="e.g. AMIT_99" required class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-3 font-black text-sm uppercase">
          </div>
          <div class="space-y-1">
            <label class="text-[8px] font-black text-slate-400 uppercase ml-2 tracking-widest">Secret Key</label>
            <input type="text" id="new-driver-pass" placeholder="Password" required class="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-3 font-black text-sm">
          </div>
          <div class="flex items-end">
            <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-xl font-black uppercase text-[10px] tracking-widest shadow-lg active:scale-95 transition-all h-[46px]">Register</button>
          </div>
        </form>
      </div>
      <div class="bg-white rounded-[2rem] border border-slate-100 shadow-sm overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-50 flex justify-between items-center bg-slate-50/30">
          <h2 class="text-[10px] font-black uppercase tracking-widest text-slate-400">Staff Roster</h2>
          <button onclick="window.refreshDrivers()" class="p-2 text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          </button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead><tr class="bg-slate-50/50 text-[9px] font-black uppercase text-slate-400 tracking-widest border-b border-slate-100"><th class="px-6 py-4">ID / Username</th><th class="px-6 py-4">Role</th><th class="px-6 py-4 text-right">Delete</th></tr></thead>
            <tbody class="divide-y divide-slate-50">
              ${state.drivers.length === 0 ? '<tr><td colspan="3" class="py-12 text-center text-slate-300 font-black uppercase text-[10px] tracking-widest">No profiles recorded</td></tr>' : state.drivers.map(d => `
                <tr class="text-xs font-bold text-slate-600 hover:bg-slate-50/50 transition-colors">
                  <td class="px-6 py-4 font-black text-slate-900 uppercase tracking-tighter">${d.username}</td>
                  <td class="px-6 py-4 uppercase text-[8px] font-black text-slate-400">${d.role}</td>
                  <td class="px-6 py-4 text-right">
                    <button onclick="window.deleteAccount('${d.username}')" class="p-1 text-red-400 hover:bg-red-50 rounded transition-colors">
                       <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

// --- Setup Listeners ---
function setupListeners() {
  const loginForm = document.getElementById('login-form');
  if (loginForm) loginForm.onsubmit = handleLogin;
  const adminCreateForm = document.getElementById('admin-create-form');
  if (adminCreateForm) {
    adminCreateForm.onsubmit = async (e) => {
      e.preventDefault();
      const otpEl = document.getElementById('admin-otp') as HTMLInputElement;
      const driverEl = document.getElementById('admin-driver') as HTMLInputElement;
      const typeEl = document.getElementById('admin-type') as HTMLSelectElement;
      const otp = otpEl.value.trim();
      if (!otp) { state.error = "OTP required"; render(); return; }
      state.loading = true; render();
      const { error } = await supabase.from('trips').insert({ 
        otp, 
        driver_id: driverEl.value.trim() || null, 
        trip_type: typeEl.value as TripType, 
        status: 'pending' 
      });
      if (error) state.error = "Cloud Sync Failed: " + error.message;
      else { state.error = null; await fetchTrips(); }
      state.loading = false; render();
    };
  }
  const driverCreateForm = document.getElementById('driver-create-form');
  if (driverCreateForm) {
    driverCreateForm.onsubmit = async (e) => {
      e.preventDefault();
      const userEl = document.getElementById('new-driver-id') as HTMLInputElement;
      const passEl = document.getElementById('new-driver-pass') as HTMLInputElement;
      const username = userEl.value.trim();
      const password = passEl.value.trim();
      if (!username || !password) { state.error = "All fields required"; render(); return; }
      state.loading = true; render();
      const { error } = await supabase.from('accounts').insert({ 
        username, 
        password, 
        role: 'driver' 
      });
      if (error) state.error = "Setup Failed: " + error.message;
      else { state.error = null; await fetchDrivers(); }
      state.loading = false; render();
    };
  }
}

// --- Interaction Helpers ---
(window as any).otpFocus = (index: number) => {
  const currentInput = document.getElementById(`otp-${index}`) as HTMLInputElement;
  if (currentInput.value.length === 1 && index < 4) {
    document.getElementById(`otp-${index + 1}`)?.focus();
  }
};
(window as any).otpKey = (event: KeyboardEvent, index: number) => {
  if (event.key === 'Backspace') {
    const currentInput = document.getElementById(`otp-${index}`) as HTMLInputElement;
    if (currentInput.value === '' && index > 1) {
      document.getElementById(`otp-${index - 1}`)?.focus();
    }
  }
};
function startTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = window.setInterval(() => {
    const el = document.getElementById('live-timer');
    if (el && state.activeTrip?.start_time) {
      const diff = Date.now() - new Date(state.activeTrip.start_time).getTime();
      const h = Math.floor(diff / 3600000).toString().padStart(2, '0');
      const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
      const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
      el.textContent = `${h}:${m}:${s}`;
    }
  }, 1000);
}
function stopTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
}
(window as any).toggleView = () => {
  state.view = state.view === 'driver' ? 'admin' : 'driver';
  localStorage.setItem('app_view', state.view);
  state.error = null;
  render();
};
(window as any).setAdminSubView = async (v: 'trips' | 'drivers') => {
  state.adminSubView = v;
  if (v === 'trips') await fetchTrips();
  if (v === 'drivers') await fetchDrivers();
  render();
};
(window as any).logout = () => {
  localStorage.clear();
  state.isAuth = false;
  state.authRole = null;
  state.authId = '';
  state.activeTrip = null;
  state.error = null;
  state.tableMissing = false;
  stopTimer();
  render();
};
(window as any).genOtp = () => {
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const el = document.getElementById('admin-otp') as HTMLInputElement;
  if (el) el.value = otp;
};
(window as any).deleteAccount = async (username: string) => {
  if (!confirm(`Remove account ${username}?`)) return;
  state.loading = true; render();
  await supabase.from('accounts').delete().eq('username', username);
  await fetchDrivers();
};
(window as any).startDuty = startDuty;
(window as any).endDuty = endDuty;
(window as any).refreshData = fetchTrips;
(window as any).refreshDrivers = fetchDrivers;
(window as any).clearError = () => { state.error = null; render(); };
(window as any).resetDriver = () => { state.activeTrip = null; render(); };

if (state.isAuth && state.authRole === 'admin') fetchTrips();
if (state.isAuth && state.authRole === 'driver') findActiveDriverTrip();
render();
