const studentRoster = [
  ["JSS1", ["Amanie Joseph", "Elochukwu David", "Igboanugo Chioma", "Obanor Marvellous", "Onwuadianu Esther", "Osita Christibel", "Nnaji Chikamso", "Uwazie Princewill", "Ugochukwu Godwin", "Okereafor Olivia", "Odianosen Anabel", "Favour Innocent", "Greatman David", "Anyanwu Uzochukwu", "Azeez Sofia"]],
  ["JSS2", ["Abdulazeez Abdulrazak", "Adekunle Daniel", "Akwuiwu Goodluck", "Chukwulobe Chidalu", "Enendu Godwin", "Ezegwu Chizzy", "Ibegbu Emmanuel", "Odianosen Praise", "Suleman Khalid", "Chinedu Rebecca", "Ekihibise Favour", "Falola Jesujumomi", "Gabriel FAVOUR", "Ibenyie vivian", "Ibrahim Fatimah", "Idikachi Divinegrace", "Nnubia Kamsiy ochukwu", "Nwabueze Jessica", "Obi anastesia", "Okafor Christabel", "Okolie praise", "Oladiji wazat", "Oruh ifenyinwa", "Otosorochi immaculate", "Robert victoria", "Soderu tofumi"]],
  ["JSS3", ["Arun chidindu", "Daniel Joshua", "Diala Banji", "Ezenwerem Wisdom", "Ibe David", "Iheoma Bright", "Nnaji chinecherem", "Ogidi Chidera", "Okeke sopuru", "Onochie Samuel", "Uba Emeka", "Ude Daniel", "Utibe Joshua", "Uwachukwu Chidubem", "Agboh Ezinne", "Emezie Daniella", "Ezeobi Chiamaka", "Godwin Confidence", "Issac Deborah", "Obi prisca", "Obiukwu Chiamaka", "Onyeaku Chiamaka", "Osabuohien favour", "Pelulola folakemi", "Samuel Mitchel", "Ugochukwu Flourish", "Osita Hillary"]],
  ["SS1", ["Barnabas Micheal", "Daniel Kingsley", "Ejike Isreal", "Ezeaka Kelvin", "Obidike Favour", "Odianosen Richmond", "Okafor kamsi", "Okerafor jeremiah", "Utaloghene Wisdom", "Chukwuemeka Amarachi", "David Princess", "James Empress", "Nnajiofor Thelma", "Nwobodo Nancy", "Obanor Favour", "Onarimi Faith", "Zubairu Idayat", "Chinatu Franklin", "Issac Melody", "Nwabueze David", "Odianosen Samuel", "Nnaeze Chidinmma", "Okolie treasure", "Chinedu Great"]],
  ["SS2", ["Anosike somto", "Chibuike Emmanuel", "Christian Chukwuebuka", "Edet David", "Enwerem Pascal", "Nnaji Chidera", "Obi Pascal", "Oladiji Wazir", "Omika Abdulsalam", "Adebowale Morenikeji", "Adekunle Ayomide", "Arum Precious", "Ajanlekoko Dorcas", "Chukwuma Confidence", "David Divine Favour", "Innocent Providence", "Nnanna Marvellous", "Nweke Oluebube", "Ohue Beatrice", "Okoh Chisom", "Olorunja Favour", "Onochie Deborah", "Friday Destiny", "Obi chidera", "Oke Toyosi", "Onwubuhari chijindu", "Success Innocent", "Okeke Oluebube", "Bello Aishat", "Benard Mirabel", "Egwu Mary", "Ekhibise Praise", "Ezenwere Divine", "Madunabuchi Marvellous", "Obi anthonia", "Okpalanze Chikamso", "Onyeoma Vera", "Okwor Chinemerem", "Tchalaho Chioma Miracle", "Ugochukwu Adaugo"]],
  ["SS3", ["Alu stephen", "Chilaka Ebuka", "Ezella Uchechukwu", "Maduka Peter", "Majule Bright", "Momoh Jubril", "Nnaze Ifeanyi", "Okafor Somtochukwu", "Okolie Victory", "Okolo Ebube", "Oladiji Waris", "Omogor Michael", "Okafor Tochukwu", "Onyeoma Chris", "Ejimchukwu Chidinma", "Ejimchukwu Chinenye", "Ejiofor Benita", "Ikeobi Ifunanya", "Joshua Richest", "Okoro Ijeoma", "Onyeaku Chidera"]],
];

const normalizedStudentRoster = studentRoster.flatMap(([className, names]) =>
  names.map((name) => ({
    name: name.trim().replace(/\s+/g, " "),
    className,
  })),
);

module.exports = { studentRoster: normalizedStudentRoster };
