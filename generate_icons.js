const fs = require('fs');
const path = require('path');

// Simulerer ikoner ved at bruge det eksisterende SVG som data-URI eller blot skrive dem hvis vi havde sharp.
// Da vi ikke har sharp, og vi ikke kan bruge browseren, 
// laver vi en løsning hvor vi bruger inline SVG i manifest hvis muligt, 
// ELLER vi instruerer brugeren i at køre generate-icons.html.

// MEN, jeg kan faktisk skrive SVG filerne og foreslå brugeren at konvertere dem, 
// eller jeg kan bruge en meget simpel placeholder.

console.log('Ikon-generering kræver manuel handling via http://localhost:3000/generate-icons.html');
console.log('Sørg for at køre serveren med: node server.js');
