/** Tiny PDF writer for synthetic fixtures. lines=[] makes a page with no text layer (like a scan). */
module.exports.makePdf=lines=>{
  const esc=s=>s.replace(/[\\()]/g,'\\$&');
  const body=lines.length?'BT /F1 12 Tf 14 TL 50 740 Td '+lines.map(l=>`(${esc(l)}) Tj T*`).join(' ')+' ET':'0.8 0.8 0.8 rg 50 400 400 200 re f 0 0 0 rg 60 410 100 20 re f';
  const objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out='%PDF-1.4\n';const off=[];
  objs.forEach((o,i)=>{off.push(out.length);out+=`${i+1} 0 obj\n${o}\nendobj\n`});
  const x=out.length;
  out+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+off.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out,'latin1');
};
// anonymized receipt lines, nothing from a real receipt
module.exports.RECEIPT=['GREEN GROCER DEMO MARKET','Branch 12  Tel 000 0000','ONIONS RED 1.2 KG   1.200','Onion 1 KG 0.900','FULL FAT MILK 1L   0.650','PLASTIC BAG   0.025','CHICKEN BREAST 2 PCS   3.400','SUBTOTAL 6.175','VAT 5%  0.300','TOTAL 6.475'];
