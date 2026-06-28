S
// ============================================
// sw.js — Service Worker FleetTrack
// Permet l'envoi GPS même appli en arrière-plan
// ============================================
 
const SW_VERSION = 'fleettrack-v1';
 
// ── Installation ──
self.addEventListener('install', (event) => {
  console.log('[SW] Installé');
  self.skipWaiting(); // Active immédiatement sans attendre
});
 
// ── Activation ──
self.addEventListener('activate', (event) => {
  console.log('[SW] Activé');
  event.waitUntil(self.clients.claim()); // Prend le contrôle immédiatement
});
 
// ============================================
// RÉCEPTION DES MESSAGES DEPUIS driver.html
// ============================================
// driver.html envoie les positions GPS au SW
// via postMessage, le SW les transmet au serveur
 
self.addEventListener('message', async (event) => {
  const { type, data } = event.data || {};
 
  if (type === 'GPS_POSITION') {
    // Tente d'envoyer la position au serveur
    await envoyerPosition(data);
  }
 
  if (type === 'STOP_GPS') {
    // Arrête la synchronisation
    console.log('[SW] GPS arrêté');
  }
});
 
// ============================================
// BACKGROUND SYNC — envoi quand réseau revient
// ============================================
// Si l'envoi échoue (hors réseau), le navigateur
// réessaiera automatiquement quand le réseau revient
 
self.addEventListener('sync', async (event) => {
  if (event.tag === 'sync-gps') {
    event.waitUntil(syncPositionsEnAttente());
  }
});
 
// ============================================
// FONCTIONS
// ============================================
 
async function envoyerPosition(data) {
  try {
    const response = await fetch('/api/gps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mission_id: data.mission_id,
        vehicle_id: data.vehicule_id,
        latitude:   data.lat,
        longitude:  data.lng,
        timestamp:  data.timestamp || new Date().toISOString()
      })
    });
 
    if (response.ok) {
      console.log('[SW] Position envoyée ✓', data.lat, data.lng);
      // Supprime de la file d'attente si elle existait
      await supprimerPositionEnAttente(data);
    } else {
      throw new Error('Réponse serveur non-ok: ' + response.status);
    }
 
  } catch (error) {
    console.warn('[SW] Envoi échoué, mise en file d\'attente:', error.message);
    // Sauvegarde la position pour la Background Sync
    await sauvegarderPositionEnAttente(data);
    // Enregistre une Background Sync si supportée
    if (self.registration.sync) {
      await self.registration.sync.register('sync-gps');
    }
  }
}
 
async function sauvegarderPositionEnAttente(data) {
  try {
    const cache = await caches.open(SW_VERSION);
    const existant = await cache.match('gps-queue');
    let queue = [];
    if (existant) {
      queue = await existant.json();
    }
    queue.push({ ...data, savedAt: new Date().toISOString() });
    // Garde max 50 positions en file (évite de saturer le cache)
    if (queue.length > 50) queue = queue.slice(-50);
    await cache.put('gps-queue', new Response(JSON.stringify(queue)));
    console.log('[SW] Position mise en file d\'attente (total:', queue.length, ')');
  } catch(e) {
    console.error('[SW] Erreur sauvegarde file:', e);
  }
}
 
async function supprimerPositionEnAttente(data) {
  try {
    const cache = await caches.open(SW_VERSION);
    const existant = await cache.match('gps-queue');
    if (!existant) return;
    let queue = await existant.json();
    // Retire la position correspondante
    queue = queue.filter(p =>
      p.lat !== data.lat || p.lng !== data.lng || p.timestamp !== data.timestamp
    );
    await cache.put('gps-queue', new Response(JSON.stringify(queue)));
  } catch(e) {}
}
 
async function syncPositionsEnAttente() {
  try {
    const cache = await caches.open(SW_VERSION);
    const existant = await cache.match('gps-queue');
    if (!existant) return;
 
    const queue = await existant.json();
    if (!queue.length) return;
 
    console.log('[SW] Sync en attente — envoi de', queue.length, 'positions...');
 
    const echouees = [];
    for (const position of queue) {
      try {
        const response = await fetch('/api/gps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mission_id: position.mission_id,
            vehicle_id: position.vehicule_id,
            latitude:   position.lat,
            longitude:  position.lng,
            timestamp:  position.timestamp
          })
        });
        if (!response.ok) throw new Error('Erreur serveur');
        console.log('[SW] Position synchronisée ✓');
      } catch(e) {
        echouees.push(position);
      }
    }
 
    // Remet en file seulement les positions qui ont échoué
    await cache.put('gps-queue', new Response(JSON.stringify(echouees)));
    console.log('[SW] Sync terminée. Échouées:', echouees.length);
 
  } catch(e) {
    console.error('[SW] Erreur sync:', e);
  }
}