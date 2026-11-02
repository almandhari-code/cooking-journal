/** Inline-SVG line chart: rating (1-5) per version of a dish. Unrated versions show as empty dots on the axis. */
export function progressChart(vs){
  const W=320,H=190,L=46,R=24,T=16,B=34,n=vs.length;
  const x=i=>n===1?(L+W-R)/2:L+16+i*(W-L-R-32)/(n-1);
  const y=r=>T+(5-r)*(H-T-B)/4;
  const grid=[1,2,3,4,5].map(r=>`<line x1="${L}" x2="${W-R}" y1="${y(r)}" y2="${y(r)}" class="grid"/><text x="${L-8}" y="${y(r)+4}" class="ax" text-anchor="end">${r}</text>`).join('');
  const rated=vs.map((v,i)=>({v,i})).filter(p=>p.v.after);
  const line=rated.length>1?`<polyline class="line" points="${rated.map(p=>`${x(p.i)},${y(p.v.after.rating)}`).join(' ')}"/>`:'';
  const dots=vs.map((v,i)=>v.after
    ?`<g class="pt"><circle cx="${x(i)}" cy="${y(v.after.rating)}" r="11"/><text x="${x(i)}" y="${y(v.after.rating)+4}" text-anchor="middle">${v.after.rating}</text></g>`
    :`<circle class="empty" cx="${x(i)}" cy="${y(1)}" r="5"/>`).join('');
  const labels=vs.map((v,i)=>`<text x="${x(i)}" y="${H-10}" class="ax" text-anchor="middle">v${v.n}</text>`).join('');
  const desc=vs.map(v=>`v${v.n}: ${v.after?v.after.rating+' stars':'not rated'}`).join(', ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating per version. ${desc}">${grid}${line}${dots}${labels}</svg>`;
}
