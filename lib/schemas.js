'use strict';

/**
 * JSON Schemas som AI:n tvingas följa (via Claude CLI:s --json-schema).
 * Hålls separat från prompterna för att vara lätta att läsa och ändra.
 */

const CONFIDENCE = { type: 'string', enum: ['verified', 'estimated', 'unknown'] };
const NUM = { type: ['number', 'null'] };
const STR = { type: ['string', 'null'] };

const flightLeg = {
  type: 'object',
  additionalProperties: false,
  required: ['date', 'departTime', 'arriveTime', 'direct', 'durationMinutes', 'airline'],
  properties: {
    date: { type: 'string', description: 'YYYY-MM-DD' },
    departTime: { type: 'string', description: 'HH:MM, lokal tid på avreseorten' },
    arriveTime: { type: 'string', description: 'HH:MM, lokal tid på ankomstorten' },
    direct: { type: 'boolean' },
    stops: NUM,
    durationMinutes: NUM,
    airline: STR,
    fromAirport: STR,
    toAirport: STR,
  },
};

const candidate = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'destination', 'country', 'nights', 'outbound', 'inbound',
    'flightPriceSek', 'flightPriceConfidence', 'hotel', 'totalPriceSek',
    'timeAtDestinationHours', 'styleMatch', 'highlights', 'restaurants',
    'events', 'sources', 'uncertainties',
  ],
  properties: {
    id: { type: 'string', description: 'kort slug, t.ex. "berlin-de"' },
    destination: { type: 'string' },
    country: { type: 'string' },
    airportCode: STR,
    nights: { type: 'number' },
    outbound: flightLeg,
    inbound: flightLeg,
    totalTravelTimeMinutes: NUM,
    timeAtDestinationHours: NUM,

    flightPriceSek: { ...NUM, description: 'tur och retur, per person, SEK' },
    flightPriceConfidence: CONFIDENCE,
    flightPriceSource: STR,

    hotel: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'area', 'rating', 'pricePerNightSek', 'totalSek', 'priceConfidence'],
      properties: {
        name: STR,
        area: STR,
        rating: { ...NUM, description: 'betyg 0-10' },
        ratingSource: STR,
        pricePerNightSek: NUM,
        totalSek: NUM,
        priceConfidence: CONFIDENCE,
        priceSource: STR,
        note: STR,
      },
    },

    totalPriceSek: { ...NUM, description: 'flyg + hotell, per person, SEK' },

    styleMatch: {
      type: 'object',
      additionalProperties: false,
      required: ['matches', 'comment'],
      properties: {
        matches: { type: 'array', items: { type: 'string' } },
        comment: { type: 'string' },
      },
    },

    highlights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description'],
        properties: { title: { type: 'string' }, description: { type: 'string' } },
      },
    },

    restaurants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'why'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          why: { type: 'string' },
          priceLevel: STR,
          source: STR,
        },
      },
    },

    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'date', 'confidence'],
        properties: {
          title: { type: 'string' },
          date: STR,
          venue: STR,
          description: STR,
          confidence: CONFIDENCE,
          source: STR,
        },
      },
    },

    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'url'],
        properties: { label: { type: 'string' }, url: { type: 'string' } },
      },
    },

    uncertainties: {
      type: 'array',
      items: { type: 'string' },
      description: 'Allt som inte gick att verifiera. Var ärlig.',
    },
  },
};

const researchSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates', 'researchNotes'],
  properties: {
    candidates: { type: 'array', items: candidate, minItems: 3, maxItems: 15 },
    researchNotes: { type: 'string', description: 'Kort om hur researchen gjordes och vad som var osäkert.' },
  },
};

const editorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['trips', 'editorNote'],
  properties: {
    trips: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'rank', 'label', 'aiScore', 'tagline', 'why', 'plan'],
        properties: {
          id: { type: 'string', description: 'måste matcha ett id från kandidatlistan' },
          rank: { type: 'number', enum: [1, 2, 3] },
          label: { type: 'string', description: 't.ex. "Bäst totalt", "Mest prisvärd"' },
          aiScore: { type: 'number', minimum: 0, maximum: 100 },
          tagline: { type: 'string', description: 'max ca 70 tecken' },
          why: { type: 'string', description: '2-4 meningar, konkret och personlig' },
          plan: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['day', 'items'],
              properties: {
                day: { type: 'string', description: 't.ex. "Fredag"' },
                items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 7 },
              },
            },
          },
        },
      },
    },
    editorNote: { type: 'string', description: 'En mening om varför just dessa tre valdes.' },
  },
};

module.exports = { researchSchema, editorSchema };
