/**
 * Setup Wizard — Step 1: Company Info
 *
 * Collects company name, admin email, and admin password.
 */

export interface CompanyInfo {
  companyName: string;
  adminEmail: string;
  adminPassword: string;
  subdomain: string;
}

export async function promptCompanyInfo(
  inquirer: any,
  chalk: any,
): Promise<CompanyInfo> {
  console.log(chalk.bold.cyan('  Step 1 of 4: Company Info'));
  console.log(chalk.dim('  Tell us about your organization.\n'));

  const { companyName, adminEmail, adminPassword } = await inquirer.prompt([
    {
      type: 'input',
      name: 'companyName',
      message: 'Company name:',
      validate: (v: string) => {
        if (!v.trim()) return 'Company name is required';
        if (v.length > 100) return 'Company name must be under 100 characters';
        return true;
      },
    },
    {
      type: 'input',
      name: 'adminEmail',
      message: 'Admin email:',
      validate: (v: string) => {
        if (!v.includes('@') || !v.includes('.')) return 'Enter a valid email address';
        return true;
      },
    },
    {
      type: 'password',
      name: 'adminPassword',
      message: 'Admin password:',
      mask: '*',
      validate: (v: string) => {
        if (v.length < 8) return 'Password must be at least 8 characters';
        if (!/[A-Z]/.test(v) && !/[0-9]/.test(v)) {
          return 'Password should contain at least one uppercase letter or number';
        }
        return true;
      },
    },
  ]);

  // Derive subdomain from company name
  const subdomain = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);

  return { companyName, adminEmail, adminPassword, subdomain };
}
