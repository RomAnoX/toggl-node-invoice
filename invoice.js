import fs from "node:fs";
import { printTable } from "console-table-printer";
import dayjs from "dayjs";
import handlebars from "handlebars";
import Papa from "papaparse";
import puppeteer from "puppeteer";

import config from "./config.json" with { type: "json" };

const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: node invoice <path/to/your/file.csv>");
  process.exit(1); // Exit with an error code
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const hoursFrom = (minutes) => parseFloat((minutes / 60).toFixed(2));

const round = (minutes) => {
  const hours = hoursFrom(minutes);
  const int = Math.floor(hours);
  const decimal = hours - int;
  // < de 12 minutos se redondea a 0
  if (decimal < 0.2) return int ? int : 0.5;
  // entre 12 y 42 minutos se agrega media hora
  if (decimal < 0.7) return int + 0.5;
  // > 42 minutos se redondea a la siguiente hora
  return int + 1;
};

const getMinutesFrom = (item) => {
  const start = new Date(`${item["Start date"]} ${item["Start time"]}`);
  const end = new Date(`${item["Stop date"]} ${item["Stop time"]}`);
  const diff = (end - start) / (1000 * 60); // difference in minutes
  return diff;
};

const getTemplate = () => {
  const templatePath = "./template.html";
  try {
    const templateString = fs.readFileSync(templatePath, "utf8");
    const template = handlebars.compile(templateString);
    return template;
  } catch (err) {
    console.error("Error reading template file:", err);
    return "";
  }
};

try {
  const csv = fs.readFileSync(filePath, "utf8");
  const parsed = Papa.parse(csv, { header: true });
  const data = parsed.data;

  const invoice = {
    date: dayjs().format("MM-DD-YYYY"),
    number: dayjs().format("YYYYMMDD"),
    billTo: config.client,
    total: 0,
    hourlyRate: config.hourlyRate,
    header: ["Description", "Hours", "Rate", "Amount"],
    billFrom: config.company,
    items: [],
    summary: {},
  };

  Object.entries(Object.groupBy(data, (item) => item.Description)).forEach(
    ([description, group]) => {
      const minutes = group.reduce(
        (sum, item) => sum + getMinutesFrom(item),
        0,
      );
      const hours = round(minutes);
      const amount = hours * invoice.hourlyRate;
      const project =
        group[0].Project === "-" ? "C&C" : group[0].Project || "C&C";
      invoice.total += amount;
      invoice.items.push({
        description: `${project} - ${description}`,
        startDate: group[0]["Start date"],
        endDate: group[group.length - 1]["Stop date"],
        hours,
        rate: usd.format(invoice.hourlyRate),
        amount: usd.format(amount),
      });
      if (!invoice.summary[project]) {
        invoice.summary[project] = 0;
      }
      invoice.summary[project] += amount;
    },
  );

  // Adding a fixed service fee of $25
  invoice.total += 25;
  invoice.items.push({
    description: "Service Fee",
    startDate: invoice.items[invoice.items.length - 1].endDate,
    endDate: invoice.items[invoice.items.length - 1].endDate,
    hours: 1,
    rate: usd.format(25),
    amount: usd.format(25),
  });
  if (!invoice.summary["C&C"]) {
    invoice.summary["C&C"] = 0;
  }
  invoice.summary["C&C"] += 25;

  console.log("Invoice Summary:");
  console.log("================");
  console.log(`Date: ${invoice.date}`);
  console.log(`Invoice Number: ${invoice.number}`);
  console.log(`Bill To: ${invoice.billTo.name}`);
  printTable(invoice.items, {
    columns: [
      { name: "description", alignment: "left", title: "Description" },
      { name: "startDate", alignment: "center", title: "Start Date" },
      { name: "endDate", alignment: "center", title: "End Date" },
      { name: "hours", alignment: "left", title: "Hours" },
      { name: "rate", alignment: "center", title: "Rate" },
      { name: "amount", alignment: "right", title: "Amount" },
    ],
  });
  console.log(`Total: ${usd.format(invoice.total)}`);
  printTable(
    Object.entries(invoice.summary).map(([Project, Total]) => ({
      Project,
      Total: usd.format(Total),
    })),
    {
      columns: [
        { name: "Project", alignment: "left" },
        { name: "Total", alignment: "right" },
      ],
    },
  );

  invoice.totalAmount = usd.format(invoice.total);

  const template = getTemplate();
  if (template) {
    const html = template({ invoice });
    const number = invoice.number;
    const client = config.client.code.replace(/\s+/g, "-");
    const outputFile = `invoice-${number}-${client}`;
    fs.writeFileSync(`archive/${outputFile}.html`, html);
    console.log(`Invoice HTML generated: ${outputFile}.html`);
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(html);
    await page.pdf({
      path: `archive/${outputFile}.pdf`,
      format: "A4",
      printBackground: true,
    });
    await browser.close();
    console.log(`Invoice PDF generated: ${outputFile}.pdf`);
  } else {
    console.error("Failed to generate invoice HTML due to template error.");
  }
} catch (err) {
  console.error("Error reading file:", err);
}
