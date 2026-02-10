import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

interface PdfExportOptions {
  title: string;
  jobId?: string;
  documentName?: string;
  filename?: string;
}

/**
 * Export an HTML element to PDF with header and footer
 */
export async function exportToPdf(
  element: HTMLElement,
  options: PdfExportOptions
): Promise<void> {
  const {
    title,
    jobId,
    documentName,
    filename = 'underwriter-analysis-report.pdf'
  } = options;

  // Create a clone of the element to modify for PDF export
  const clone = element.cloneNode(true) as HTMLElement;

  // Remove any download buttons from the clone
  const downloadButtons = clone.querySelectorAll('.pdf-download-btn, .section-download-btn');
  downloadButtons.forEach(btn => btn.remove());

  // Create a temporary container
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-9999px';
  container.style.top = '0';
  container.style.width = '800px';
  container.style.backgroundColor = '#ffffff';
  container.style.padding = '20px';
  container.appendChild(clone);
  document.body.appendChild(container);

  try {
    // Generate canvas from HTML
    const canvas = await html2canvas(clone, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
      windowWidth: 800
    });

    // Calculate PDF dimensions
    const imgWidth = 210; // A4 width in mm
    const pageHeight = 297; // A4 height in mm
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    // Header and footer heights
    const headerHeight = 35;
    const footerHeight = 15;
    const contentHeight = pageHeight - headerHeight - footerHeight;

    // Calculate total pages needed
    const totalPages = Math.ceil(imgHeight / contentHeight);

    // Create PDF
    const pdf = new jsPDF('p', 'mm', 'a4');

    // Format current date
    const now = new Date();
    const dateStr = now.toLocaleString();

    // Add pages
    for (let page = 0; page < totalPages; page++) {
      if (page > 0) {
        pdf.addPage();
      }

      // Add header
      addHeader(pdf, title, {
        generatedOn: `Generated: ${dateStr}`,
        jobId: jobId ? `Job ID: ${jobId}` : undefined,
        documentName: documentName ? `Document: ${documentName}` : undefined
      });

      // Calculate source and destination coordinates for this page
      const sourceY = page * (contentHeight / imgWidth) * canvas.width;
      const sourceHeight = Math.min(
        (contentHeight / imgWidth) * canvas.width,
        canvas.height - sourceY
      );

      // Create a canvas for this page's content
      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = canvas.width;
      pageCanvas.height = sourceHeight;
      const ctx = pageCanvas.getContext('2d');

      if (ctx) {
        ctx.drawImage(
          canvas,
          0, sourceY,
          canvas.width, sourceHeight,
          0, 0,
          canvas.width, sourceHeight
        );

        const pageImgData = pageCanvas.toDataURL('image/png');
        const pageImgHeight = (sourceHeight * imgWidth) / canvas.width;

        pdf.addImage(
          pageImgData,
          'PNG',
          0,
          headerHeight,
          imgWidth,
          pageImgHeight
        );
      }

      // Add footer with page number
      const pageText = `Page ${page + 1} of ${totalPages}`;
      addFooter(pdf, pageText, pageHeight);
    }

    // Download the PDF
    pdf.save(filename);

  } finally {
    // Clean up
    document.body.removeChild(container);
  }
}

/**
 * Export a single section to PDF
 */
export async function exportSectionToPdf(
  element: HTMLElement,
  sectionTitle: string,
  options: Omit<PdfExportOptions, 'title'>
): Promise<void> {
  return exportToPdf(element, {
    ...options,
    title: sectionTitle,
    filename: `${sectionTitle.toLowerCase().replace(/\s+/g, '-')}-report.pdf`
  });
}

/**
 * Add header to PDF page
 */
function addHeader(
  pdf: jsPDF,
  title: string,
  metadata: {
    generatedOn: string;
    jobId?: string;
    documentName?: string;
  }
): void {
  const pageWidth = pdf.internal.pageSize.getWidth();

  // Title
  pdf.setFontSize(16);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(30, 64, 175); // Blue color
  pdf.text(title, pageWidth / 2, 12, { align: 'center' });

  // Metadata
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(100, 100, 100);

  let yPos = 20;

  if (metadata.generatedOn) {
    pdf.text(metadata.generatedOn, 10, yPos);
    yPos += 5;
  }

  if (metadata.jobId) {
    pdf.text(metadata.jobId, 10, yPos);
    yPos += 5;
  }

  if (metadata.documentName) {
    // Truncate long document names
    const maxLength = 60;
    const docName = metadata.documentName.length > maxLength
      ? metadata.documentName.substring(0, maxLength) + '...'
      : metadata.documentName;
    pdf.text(docName, 10, yPos);
  }

  // Divider line
  pdf.setDrawColor(200, 200, 200);
  pdf.line(10, 33, pageWidth - 10, 33);
}

/**
 * Add footer to PDF page
 */
function addFooter(pdf: jsPDF, pageText: string, pageHeight: number): void {
  const pageWidth = pdf.internal.pageSize.getWidth();

  // Divider line
  pdf.setDrawColor(200, 200, 200);
  pdf.line(10, pageHeight - 12, pageWidth - 10, pageHeight - 12);

  // Page number
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(100, 100, 100);
  pdf.text(pageText, pageWidth / 2, pageHeight - 6, { align: 'center' });
}


