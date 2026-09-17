'use strict';

/**
 * Bokningslänkar.
 *
 * Byggs DETERMINISTISKT i kod — aldrig av AI:n. En modell som ombeds hitta på
 * en boknings-URL gissar parametrar och producerar länkar som går till fel datum
 * eller 404. Här sätts orten och datumen ihop enligt varje sajts publika format,
 * så länken stämmer alltid med resan som visas.
 *
 * Länkarna går till SÖKRESULTAT, inte till en färdig bokning. Priset som möter
 * användaren är leverantörens, inte vår uppskattning.
 */

/** IATA-koder för de avreseorter vi realistiskt möter. Saknas orten används fritext. */
const IATA = {
  göteborg: 'GOT', gothenburg: 'GOT', landvetter: 'GOT',
  stockholm: 'STO', arlanda: 'ARN', bromma: 'BMA', skavsta: 'NYO',
  malmö: 'MMX', malmo: 'MMX', köpenhamn: 'CPH', copenhagen: 'CPH',
  oslo: 'OSL', helsingfors: 'HEL', umeå: 'UME', luleå: 'LLA',
  göteborg_landvetter: 'GOT',
};

function iata(place, fallbackCode) {
  if (fallbackCode && /^[A-Z]{3}$/.test(String(fallbackCode))) return fallbackCode;
  const key = String(place || '').toLowerCase().trim();
  return IATA[key] || null;
}

const enc = encodeURIComponent;

/**
 * Google Flights. Söksträngen är robust: den tål både IATA och ortsnamn och
 * tolkar datumen, till skillnad från den kodade tfs-parametern som ändras.
 */
function flightSearch({ origin, destination, originCode, destinationCode, outDate, inDate }) {
  const from = iata(origin, originCode) || origin;
  const to = iata(destination, destinationCode) || destination;
  if (!from || !to || !outDate) return null;
  const q = `Flights from ${from} to ${to} on ${outDate}${inDate ? ` through ${inDate}` : ''}`;
  return {
    label: 'Sök flyg på Google Flights',
    url: `https://www.google.com/travel/flights?q=${enc(q)}`,
  };
}

/** Skyscanner: yymmdd i sökvägen. Bra komplement när Google Flights saknar lågprisbolag. */
function skyscanner({ origin, destination, originCode, destinationCode, outDate, inDate }) {
  const from = iata(origin, originCode);
  const to = iata(destination, destinationCode);
  if (!from || !to || !outDate) return null;
  const short = (d) => (d || '').slice(2).replace(/-/g, '');
  return {
    label: 'Jämför på Skyscanner',
    url: `https://www.skyscanner.se/transport/flights/${from.toLowerCase()}/${to.toLowerCase()}`
      + `/${short(outDate)}${inDate ? `/${short(inDate)}` : ''}/`,
  };
}

/** Booking.com-sökning på destination och datum. Hotellnamnet läggs som fritext om vi har det. */
function hotelSearch({ destination, hotelName, checkIn, checkOut, nights }) {
  if (!destination || !checkIn) return null;
  const term = hotelName ? `${hotelName}, ${destination}` : destination;
  const params = new URLSearchParams({
    ss: term,
    checkin: checkIn,
    checkout: checkOut || checkIn,
    group_adults: '2',
    no_rooms: '1',
    group_children: '0',
  });
  return {
    label: hotelName ? `Sök ${hotelName} på Booking.com` : 'Sök hotell på Booking.com',
    url: `https://www.booking.com/searchresults.sv.html?${params.toString()}`,
    nights: nights || null,
  };
}

/** Hotells omdömen i andra hand — låter användaren kolla kvaliteten själv. */
function hotelReviews({ destination, hotelName }) {
  if (!hotelName) return null;
  return {
    label: `Läs omdömen om ${hotelName}`,
    url: `https://www.google.com/search?q=${enc(`${hotelName} ${destination} recensioner omdöme`)}`,
  };
}

/** Allt som behövs för att faktiskt boka resan. */
function linksFor({ origin, destination, originCode, destinationCode,
  outDate, inDate, hotelName, nights }) {
  return {
    flights: [
      flightSearch({ origin, destination, originCode, destinationCode, outDate, inDate }),
      skyscanner({ origin, destination, originCode, destinationCode, outDate, inDate }),
    ].filter(Boolean),
    hotel: [
      hotelSearch({ destination, hotelName, checkIn: outDate, checkOut: inDate, nights }),
      hotelReviews({ destination, hotelName }),
    ].filter(Boolean),
  };
}

module.exports = { linksFor, flightSearch, skyscanner, hotelSearch, hotelReviews, iata };
